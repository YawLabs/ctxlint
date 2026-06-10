import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LintIssue, SessionContext } from '../../types.js';
import { encodeProjectDir } from '../../session-parser.js';
import { stripBom } from '../../../utils/fs.js';

/**
 * Claude Code loads the first 200 lines OR 25KB of MEMORY.md at session
 * start — whichever comes first. Content past that cap is silently dropped
 * (topic files stay on-demand but MEMORY.md acts as the index, so entries
 * beyond the cap are effectively invisible to the agent).
 *
 * Source: code.claude.com/docs/en/memory (validated 2026-04-12).
 */

const MAX_LINES = 200;
const MAX_BYTES = 25 * 1024;

export async function checkMemoryIndexOverflow(ctx: SessionContext): Promise<LintIssue[]> {
  // Env-first so tests/sandboxes can redirect home, OS fallback so a shell
  // with neither HOME nor USERPROFILE (e.g. some Windows service contexts)
  // still resolves instead of silently skipping the check.
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  if (!home) return [];

  const encoded = encodeProjectDir(ctx.currentProject);
  const memoryFile = join(home, '.claude', 'projects', encoded, 'memory', 'MEMORY.md');

  let content: string;
  try {
    content = stripBom(await readFile(memoryFile, 'utf-8'));
  } catch {
    return [];
  }
  if (!content) return [];

  // A newline-terminated file (the normal shape for generated MEMORY.md)
  // splits into a trailing empty element; don't count it as a line, or every
  // line count inflates by one and an exactly-200-line file falsely fires.
  const lines = content.split('\n');
  const lineCount = content.endsWith('\n') ? lines.length - 1 : lines.length;
  // Use the post-BOM-strip byte length, not stats.size. Claude Code measures
  // the loaded *content*, so a 25600-byte file with a 3-byte BOM would only
  // load 25597 content bytes — using stats.size flags it falsely. UTF-8 byte
  // length is what the cap is actually expressed in.
  const byteSize = Buffer.byteLength(content, 'utf8');

  const issues: LintIssue[] = [];

  if (lineCount > MAX_LINES) {
    const excess = lineCount - MAX_LINES;
    issues.push({
      severity: 'warning',
      check: 'session-memory-index-overflow',
      ruleId: 'session-memory-index-overflow/line-overflow',
      line: MAX_LINES + 1,
      message: `MEMORY.md has ${lineCount.toLocaleString()} lines — only the first ${MAX_LINES} are loaded. ${excess.toLocaleString()} line(s) are effectively invisible to the agent.`,
      detail: `File: ${memoryFile}`,
      suggestion:
        "Trim older entries, consolidate duplicates, or split into topic files (topic files stay on-demand and don't count toward this cap).",
    });
  }

  if (byteSize > MAX_BYTES) {
    const excess = byteSize - MAX_BYTES;
    issues.push({
      severity: 'warning',
      check: 'session-memory-index-overflow',
      ruleId: 'session-memory-index-overflow/byte-overflow',
      line: 0,
      message: `MEMORY.md is ${byteSize.toLocaleString()} bytes — only the first ${MAX_BYTES.toLocaleString()} bytes are loaded. ~${excess.toLocaleString()} bytes are effectively invisible.`,
      detail: `File: ${memoryFile}`,
      suggestion:
        'Each index entry should stay under ~150 characters. Trim verbose lines or move details into the corresponding topic file.',
    });
  }

  return issues;
}
