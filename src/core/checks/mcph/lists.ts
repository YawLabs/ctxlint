import type { LintIssue, ParsedMchpConfig } from '../../types.js';

export async function checkMcphLists(
  config: ParsedMchpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  if (config.parseErrors.length > 0) return issues;

  const servers = config.listEntries.servers;
  const blocked = config.listEntries.blocked;
  const blockedSet = new Set(blocked.map((e) => e.value));

  // --- Rule: mcph-config/allowlist-denylist-conflict ---
  for (const entry of servers) {
    if (blockedSet.has(entry.value)) {
      issues.push({
        severity: 'warning',
        check: 'mcph-lists',
        ruleId: 'mcph-config/allowlist-denylist-conflict',
        line: entry.position.line,
        message: `server "${entry.value}" is in both "servers" (allow-list) and "blocked" (deny-list)`,
        suggestion: `Remove "${entry.value}" from one of the two lists. "blocked" wins in practice (deny > allow), so the allow-list entry is dead weight.`,
      });
    }
  }

  // --- Rule: mcph-config/duplicate-entries ---
  for (const listName of ['servers', 'blocked'] as const) {
    const entries = config.listEntries[listName];
    const seen = new Map<string, number>();
    for (const entry of entries) {
      const prevLine = seen.get(entry.value);
      if (prevLine !== undefined) {
        issues.push({
          severity: 'info',
          check: 'mcph-lists',
          ruleId: 'mcph-config/duplicate-entries',
          line: entry.position.line,
          message: `"${entry.value}" appears multiple times in "${listName}" (first at line ${prevLine})`,
          suggestion: `Remove the duplicate entry at line ${entry.position.line}.`,
        });
      } else {
        seen.set(entry.value, entry.position.line);
      }
    }
  }

  return issues;
}
