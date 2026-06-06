import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkMemoryIndexOverflow } from '../memory-index-overflow.js';
import { encodeProjectDir } from '../../../session-parser.js';
import type { SessionContext } from '../../../types.js';

let tmpHome: string;
let originalHome: string | undefined;
let originalUserProfile: string | undefined;

const projectPath = 'C:/projects/example';

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-mem-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterEach(() => {
  process.env.HOME = originalHome;
  process.env.USERPROFILE = originalUserProfile;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function seedMemoryFile(content: string): void {
  const encoded = encodeProjectDir(projectPath);
  const dir = path.join(tmpHome, '.claude', 'projects', encoded, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), content);
}

function makeCtx(): SessionContext {
  return {
    history: [],
    memories: [],
    siblings: [],
    currentProject: projectPath,
    providers: ['claude-code'],
  };
}

describe('checkMemoryIndexOverflow', () => {
  it('returns no issues when no MEMORY.md exists', async () => {
    const issues = await checkMemoryIndexOverflow(makeCtx());
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when MEMORY.md is small', async () => {
    seedMemoryFile(['- [a](a.md) — alpha', '- [b](b.md) — beta', '- [c](c.md) — gamma'].join('\n'));
    const issues = await checkMemoryIndexOverflow(makeCtx());
    expect(issues).toHaveLength(0);
  });

  it('warns when MEMORY.md exceeds 200 lines', async () => {
    const lines = Array.from({ length: 250 }, (_, i) => `- [t${i}](t${i}.md) — entry ${i}`);
    seedMemoryFile(lines.join('\n'));
    const issues = await checkMemoryIndexOverflow(makeCtx());
    expect(issues.length).toBeGreaterThan(0);
    const lineIssue = issues.find((i) => i.message.includes('lines'));
    expect(lineIssue).toBeDefined();
    expect(lineIssue!.severity).toBe('warning');
    expect(lineIssue!.ruleId).toBe('session-memory-index-overflow/line-overflow');
  });

  it('warns when MEMORY.md exceeds 25KB', async () => {
    // Build a file that's under 200 lines but over 25KB by using very long lines.
    const longLine = '- [x](x.md) -- ' + 'y'.repeat(500);
    const lines = Array.from({ length: 60 }, () => longLine);
    seedMemoryFile(lines.join('\n'));
    const issues = await checkMemoryIndexOverflow(makeCtx());
    const byteIssue = issues.find((i) => i.message.includes('bytes'));
    expect(byteIssue).toBeDefined();
    expect(byteIssue!.severity).toBe('warning');
    expect(byteIssue!.ruleId).toBe('session-memory-index-overflow/byte-overflow');
  });

  it('emits distinct ruleIds when a file exceeds both caps', async () => {
    // A file over both the line and byte caps must not emit two issues sharing
    // one ruleId (SARIF fingerprint collision). Each long line crosses the
    // line cap; the sheer volume crosses the byte cap.
    const longLine = '- [x](x.md) -- ' + 'y'.repeat(200);
    const lines = Array.from({ length: 250 }, () => longLine);
    seedMemoryFile(lines.join('\n'));
    const issues = await checkMemoryIndexOverflow(makeCtx());
    const ruleIds = issues.map((i) => i.ruleId);
    expect(ruleIds).toContain('session-memory-index-overflow/line-overflow');
    expect(ruleIds).toContain('session-memory-index-overflow/byte-overflow');
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
  });

  it('does not flag a file under the cap that only crosses it via BOM', async () => {
    // Claude Code measures the loaded *content*, not raw disk bytes. A file
    // whose post-BOM content is under the 25KB cap should not be flagged
    // even though the BOM-prefixed disk size pushes it over.
    //
    // 25,599 content bytes + 3-byte BOM = 25,602 raw bytes (over the 25,600
    // cap on disk, under it in memory).
    const filler = 'a'.repeat(25_599);
    seedMemoryFileRaw('﻿' + filler);
    const issues = await checkMemoryIndexOverflow(makeCtx());
    const byteIssue = issues.find((i) => i.message.includes('bytes'));
    expect(byteIssue).toBeUndefined();
  });
});

function seedMemoryFileRaw(content: string): void {
  // Variant of seedMemoryFile that writes the exact bytes (including a
  // leading BOM) without any encoding gymnastics.
  const encoded = encodeProjectDir(projectPath);
  const dir = path.join(tmpHome, '.claude', 'projects', encoded, 'memory');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), content, { encoding: 'utf8' });
}
