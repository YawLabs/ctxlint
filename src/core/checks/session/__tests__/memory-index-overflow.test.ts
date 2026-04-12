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
    expect(lineIssue!.ruleId).toBe('session/memory-index-overflow');
  });

  it('warns when MEMORY.md exceeds 25KB', async () => {
    // Build a file that's under 200 lines but over 25KB by using very long lines.
    const longLine = '- [x](x.md) — ' + 'y'.repeat(500);
    const lines = Array.from({ length: 60 }, () => longLine);
    seedMemoryFile(lines.join('\n'));
    const issues = await checkMemoryIndexOverflow(makeCtx());
    const byteIssue = issues.find((i) => i.message.includes('bytes'));
    expect(byteIssue).toBeDefined();
    expect(byteIssue!.severity).toBe('warning');
  });
});
