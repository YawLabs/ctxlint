import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LintIssue, SessionContext } from '../../types.js';
import { encodeProjectDir } from '../../session-parser.js';

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
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return [];

  const encoded = encodeProjectDir(ctx.currentProject);
  const memoryFile = join(home, '.claude', 'projects', encoded, 'memory', 'MEMORY.md');

  let stats;
  try {
    stats = await stat(memoryFile);
  } catch {
    return [];
  }

  const content = await readFile(memoryFile, 'utf-8').catch(() => '');
  if (!content) return [];

  const lines = content.split('\n');
  const lineCount = lines.length;
  const byteSize = stats.size;

  const issues: LintIssue[] = [];

  if (lineCount > MAX_LINES) {
    const excess = lineCount - MAX_LINES;
    issues.push({
      severity: 'warning',
      check: 'session-memory-index-overflow',
      ruleId: 'session/memory-index-overflow',
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
      ruleId: 'session/memory-index-overflow',
      line: 0,
      message: `MEMORY.md is ${byteSize.toLocaleString()} bytes — only the first ${MAX_BYTES.toLocaleString()} bytes are loaded. ~${excess.toLocaleString()} bytes are effectively invisible.`,
      detail: `File: ${memoryFile}`,
      suggestion:
        'Each index entry should stay under ~150 characters. Trim verbose lines or move details into the corresponding topic file.',
    });
  }

  return issues;
}
