import type { LintIssue, ParsedMchpConfig } from '../../types.js';

const CURRENT_SCHEMA_VERSION = 1;

export async function checkMcphSchemaConformance(
  config: ParsedMchpConfig,
  _projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  if (config.parseErrors.length > 0) return issues;

  // --- Rule: mcph-config/unknown-field ---
  for (const field of config.unknownFields) {
    issues.push({
      severity: 'warning',
      check: 'mcph-schema-conformance',
      ruleId: 'mcph-config/unknown-field',
      line: field.position.line,
      message: `unknown field "${field.name}" — not in the mcph config schema`,
      suggestion: `Known fields: $schema, version, token, apiBase, servers, blocked. Check for typos (e.g. "tokens" vs "token", "blockList" vs "blocked").`,
    });
  }

  // --- Rule: mcph-config/stale-version ---
  const versionPos = config.positions.version;
  const version = typeof config.raw?.version === 'number' ? config.raw.version : undefined;
  if (versionPos && typeof version === 'number' && version < CURRENT_SCHEMA_VERSION) {
    issues.push({
      severity: 'info',
      check: 'mcph-schema-conformance',
      ruleId: 'mcph-config/stale-version',
      line: versionPos.line,
      message: `"version": ${version} is older than the current schema version (${CURRENT_SCHEMA_VERSION})`,
      suggestion: `Update to "version": ${CURRENT_SCHEMA_VERSION}. Older versions continue to load but may miss newer fields.`,
    });
  }

  return issues;
}
