import { describe, it, expect } from 'vitest';
import { formatText, formatJson, formatTokenReport, formatSarif } from '../reporter.js';
import {
  ALL_CHECKS,
  ALL_MCP_CHECKS,
  ALL_MCPH_CHECKS,
  ALL_SESSION_CHECKS,
  ALL_SKILL_CHECKS,
} from '../audit.js';
import { VERSION as PKG_VERSION } from '../../version.js';
import { SESSION_AUDIT_LABEL, SKILL_AUDIT_LABEL, type LintResult } from '../types.js';

function makeResult(overrides?: Partial<LintResult>): LintResult {
  return {
    version: PKG_VERSION,
    scannedAt: '2026-04-06T10:00:00Z',
    projectRoot: '/test/project',
    files: [
      {
        path: 'CLAUDE.md',
        isSymlink: false,
        tokens: 500,
        lines: 20,
        issues: [
          {
            severity: 'error',
            check: 'paths',
            line: 5,
            message: 'src/foo.ts does not exist',
            suggestion: 'Did you mean src/bar.ts?',
          },
          {
            severity: 'info',
            check: 'redundancy',
            line: 3,
            message: '"React" is in package.json dependencies',
            suggestion: '~10 tokens could be saved',
          },
        ],
      },
    ],
    summary: {
      errors: 1,
      warnings: 0,
      info: 1,
      totalTokens: 500,
      estimatedWaste: 10,
    },
    ...overrides,
  };
}

describe('formatText', () => {
  it('includes version and project root', () => {
    const output = formatText(makeResult());
    expect(output).toContain(`ctxlint v${PKG_VERSION}`);
    expect(output).toContain('/test/project');
  });

  it('includes file issues', () => {
    const output = formatText(makeResult());
    expect(output).toContain('src/foo.ts does not exist');
    expect(output).toContain('Did you mean src/bar.ts?');
  });

  it('includes summary counts', () => {
    const output = formatText(makeResult());
    expect(output).toContain('1 error');
    expect(output).toContain('1 info');
  });

  it('shows symlink info', () => {
    const result = makeResult({
      files: [
        {
          path: 'AGENTS.md',
          isSymlink: true,
          symlinkTarget: 'CLAUDE.md',
          tokens: 100,
          lines: 5,
          issues: [],
        },
      ],
    });
    const output = formatText(result);
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('symlink');
  });

  it('shows passing checks in verbose mode', () => {
    const result = makeResult({
      files: [{ path: 'CLAUDE.md', isSymlink: false, tokens: 100, lines: 5, issues: [] }],
      summary: { errors: 0, warnings: 0, info: 0, totalTokens: 100, estimatedWaste: 0 },
    });
    const output = formatText(result, true);
    expect(output).toContain('All checks passed');
  });
});

describe('formatJson', () => {
  it('returns valid JSON', () => {
    const output = formatJson(makeResult());
    const parsed = JSON.parse(output);
    expect(parsed.version).toBe(PKG_VERSION);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.summary.errors).toBe(1);
  });

  it('includes _meta.ignoreReport when present', () => {
    const result = makeResult({
      _meta: {
        ignoreReport: {
          dropped: 3,
          unusedRules: [{ check: 'paths', match: 'foo', reason: 'r' }],
          rulesMissingReason: [{ check: 'commands' }],
        },
      },
    });
    const parsed = JSON.parse(formatJson(result));
    expect(parsed._meta.ignoreReport.dropped).toBe(3);
    expect(parsed._meta.ignoreReport.unusedRules).toHaveLength(1);
    expect(parsed._meta.ignoreReport.unusedRules[0].match).toBe('foo');
    expect(parsed._meta.ignoreReport.rulesMissingReason).toHaveLength(1);
  });
});

describe('formatText — ignore-rule drift footer', () => {
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  it('renders nothing when ignoreReport is absent', () => {
    const plain = stripAnsi(formatText(makeResult()));
    expect(plain).not.toContain('Ignore rules');
  });

  it('renders nothing when ignoreReport has zero drift', () => {
    const result = makeResult({
      _meta: {
        ignoreReport: { dropped: 0, unusedRules: [], rulesMissingReason: [] },
      },
    });
    const plain = stripAnsi(formatText(result));
    expect(plain).not.toContain('Ignore rules');
  });

  it('reports dropped count, unused rules, and rules missing reason', () => {
    const result = makeResult({
      _meta: {
        ignoreReport: {
          dropped: 2,
          unusedRules: [
            {
              check: 'session-stale-memory',
              pathPattern: '^/[a-z-]+$',
              reason: 'covered by classifier',
            },
          ],
          rulesMissingReason: [{ check: 'commands', match: 'foo' }],
        },
      },
    });
    const plain = stripAnsi(formatText(result));
    expect(plain).toContain('Ignore rules');
    expect(plain).toContain('2 findings dropped by ignoreRules');
    expect(plain).toContain('1 ignore rule never fired');
    expect(plain).toContain('session-stale-memory');
    expect(plain).toContain('pathPattern=/^/[a-z-]+$/');
    expect(plain).toContain('1 ignore rule missing a "reason" field');
    expect(plain).toContain('commands');
    expect(plain).toContain('match=/foo/');
  });

  it('pluralizes correctly with multiple drift entries', () => {
    const result = makeResult({
      _meta: {
        ignoreReport: {
          dropped: 1,
          unusedRules: [{ check: 'paths' }, { check: 'commands' }],
          rulesMissingReason: [{ check: 'paths' }, { check: 'commands' }],
        },
      },
    });
    const plain = stripAnsi(formatText(result));
    expect(plain).toContain('1 finding dropped by ignoreRules');
    expect(plain).toContain('2 ignore rules never fired');
    expect(plain).toContain('2 ignore rules missing a "reason" field');
  });
});

describe('formatTokenReport', () => {
  it('includes file token counts', () => {
    const output = formatTokenReport(makeResult());
    expect(output).toContain('CLAUDE.md');
    expect(output).toContain('500');
  });

  it('includes waste estimate', () => {
    const output = formatTokenReport(makeResult());
    expect(output).toContain('10 tokens');
  });

  it('handles empty files array without crashing', () => {
    const result = makeResult({
      files: [],
      summary: { errors: 0, warnings: 0, info: 0, totalTokens: 0, estimatedWaste: 0 },
    });
    const output = formatTokenReport(result);
    expect(output).toContain('Token Usage Report');
  });
});

describe('formatSarif', () => {
  it('produces valid SARIF 2.1.0 structure', () => {
    const parsed = JSON.parse(formatSarif(makeResult()));
    expect(parsed.version).toBe('2.1.0');
    expect(parsed.$schema).toContain('sarif');
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.runs[0].tool.driver.name).toBe('ctxlint');
    expect(parsed.runs[0].results).toHaveLength(2);
  });

  it('maps error/warning/info severities to SARIF error/warning/note', () => {
    const result = makeResult({
      files: [
        {
          path: 'CLAUDE.md',
          isSymlink: false,
          tokens: 100,
          lines: 5,
          issues: [
            { severity: 'error', check: 'paths', line: 1, message: 'e' },
            { severity: 'warning', check: 'tokens', line: 2, message: 'w' },
            { severity: 'info', check: 'redundancy', line: 3, message: 'i' },
          ],
        },
      ],
    });
    const parsed = JSON.parse(formatSarif(result));
    const levels = parsed.runs[0].results.map((r: { level: string }) => r.level);
    expect(levels).toEqual(['error', 'warning', 'note']);
  });

  it('appends issue detail to the SARIF message text', () => {
    const result = makeResult({
      files: [
        {
          path: 'CLAUDE.md',
          isSymlink: false,
          tokens: 100,
          lines: 5,
          issues: [
            {
              severity: 'warning',
              check: 'staleness',
              line: 1,
              message: 'stale',
              detail: '5 commits since last update',
            },
          ],
        },
      ],
    });
    const parsed = JSON.parse(formatSarif(result));
    expect(parsed.runs[0].results[0].message.text).toContain('5 commits since last update');
  });

  it('emits valid SARIF when there are no files or issues', () => {
    const parsed = JSON.parse(
      formatSarif(
        makeResult({
          files: [],
          summary: { errors: 0, warnings: 0, info: 0, totalTokens: 0, estimatedWaste: 0 },
        }),
      ),
    );
    expect(parsed.runs[0].results).toEqual([]);
  });

  it('clamps line numbers below 1 to at least 1', () => {
    const result = makeResult({
      files: [
        {
          path: 'CLAUDE.md',
          isSymlink: false,
          tokens: 100,
          lines: 5,
          issues: [{ severity: 'warning', check: 'tokens', line: 0, message: 'x' }],
        },
      ],
    });
    const parsed = JSON.parse(formatSarif(result));
    expect(parsed.runs[0].results[0].locations[0].physicalLocation.region.startLine).toBe(1);
  });

  // Audit buckets cross-file findings under labels like `(project)`, `(mcp)`,
  // and `~/.claude/ (session audit)`. Those are not real repo-relative paths,
  // so routing them through SARIF's `physicalLocation.artifactLocation.uri`
  // makes GitHub Code Scanning either drop the result or file it against a
  // literal "(project)" path. We emit `logicalLocations` for these instead.
  it('uses logicalLocations (not physicalLocation) for synthetic cross-file paths', () => {
    const result = makeResult({
      files: [
        {
          path: '(project)',
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [
            {
              severity: 'warning',
              check: 'contradictions',
              line: 0,
              message: 'Jest vs Vitest',
            },
          ],
        },
        {
          path: SESSION_AUDIT_LABEL,
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [
            {
              severity: 'info',
              check: 'session-stale-memory',
              line: 0,
              message: 'stale memory',
            },
          ],
        },
        {
          path: 'CLAUDE.md',
          isSymlink: false,
          tokens: 10,
          lines: 1,
          issues: [{ severity: 'error', check: 'paths', line: 3, message: 'missing' }],
        },
      ],
    });
    const parsed = JSON.parse(formatSarif(result));
    const [projectResult, sessionResult, fileResult] = parsed.runs[0].results;

    // Synthetic project bucket — no physicalLocation, logicalLocations carries the label.
    expect(projectResult.locations[0].physicalLocation).toBeUndefined();
    expect(projectResult.locations[0].logicalLocations[0].name).toBe('(project)');

    // Synthetic session bucket — same treatment. Leading `~` is the tell.
    expect(sessionResult.locations[0].physicalLocation).toBeUndefined();
    expect(sessionResult.locations[0].logicalLocations[0].name).toBe('~/.claude/ (session audit)');

    // Real file path — unchanged, still uses physicalLocation (regression guard).
    expect(fileResult.locations[0].physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    expect(fileResult.locations[0].physicalLocation.region.startLine).toBe(3);
    expect(fileResult.locations[0].logicalLocations).toBeUndefined();
  });

  it('exposes rule descriptors in the tool driver for all ctxlint check categories', () => {
    const parsed = JSON.parse(formatSarif(makeResult()));
    const ruleIds = parsed.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ruleIds).toContain('ctxlint/paths');
    expect(ruleIds).toContain('ctxlint/tokens');
    expect(ruleIds).toContain('ctxlint/contradictions');
  });

  // Self-validating guard: SARIF descriptors must cover every active check
  // name. This catches the case where a new check is wired into ALL_*CHECKS
  // but buildRuleDescriptors is forgotten — which happened for `tier-tokens`
  // and `session-memory-index-overflow` between v0.9.2 and v0.9.5, and
  // happened again for the entire `ALL_MCPH_CHECKS` family which the earlier
  // version of THIS test forgot to include in `expected` (so the absence
  // of mcph descriptors went undetected for several releases). Keep all four
  // catalogs in sync with the constant lists in audit.ts.
  it('SARIF descriptors cover every check in ALL_CHECKS / ALL_MCP_CHECKS / ALL_MCPH_CHECKS / ALL_SESSION_CHECKS / ALL_SKILL_CHECKS', () => {
    // Imported at module top — `await import()` here used to occasionally
    // time out under parallel test load while waiting for the audit module's
    // tiktoken/zod/etc. import chain to resolve.
    const parsed = JSON.parse(formatSarif(makeResult()));
    const ruleIds: string[] = parsed.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    const expected = [
      ...ALL_CHECKS,
      ...ALL_MCP_CHECKS,
      ...ALL_MCPH_CHECKS,
      ...ALL_SESSION_CHECKS,
      ...ALL_SKILL_CHECKS,
    ].map((c: string) => `ctxlint/${c}`);
    const missing = expected.filter((id) => !ruleIds.includes(id));
    expect(missing).toEqual([]);
  });
});

describe('formatText — group classification', () => {
  // `'mcph-token-security'.startsWith('mcp-')` is FALSE (the 4th char is `h`,
  // not `-`), and `'session-*'` doesn't start with `mcp-` either. The
  // pre-fix classifier used a single `mcp-` prefix test as the splitter, so
  // mcph + session rows ended up under the bold "Context Files" header in
  // mixed-mode output. This test guards the four-group classifier.
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  function mixedResult(): LintResult {
    return makeResult({
      files: [
        {
          path: 'CLAUDE.md',
          isSymlink: false,
          tokens: 100,
          lines: 5,
          issues: [{ severity: 'error', check: 'paths', line: 1, message: 'broken context path' }],
        },
        {
          path: '.mcp.json',
          isSymlink: false,
          tokens: 30,
          lines: 5,
          issues: [{ severity: 'error', check: 'mcp-schema', line: 1, message: 'no servers key' }],
        },
        {
          path: '.mcph.json',
          isSymlink: false,
          tokens: 20,
          lines: 3,
          issues: [
            {
              severity: 'warning',
              check: 'mcph-token-security',
              line: 2,
              message: 'token in mcph file',
            },
          ],
        },
        {
          path: SESSION_AUDIT_LABEL,
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [
            {
              severity: 'info',
              check: 'session-stale-memory',
              line: 0,
              message: 'memory ref missing',
            },
          ],
        },
      ],
      summary: { errors: 2, warnings: 1, info: 1, totalTokens: 150, estimatedWaste: 0 },
    });
  }

  it('renders bold group headers for context, MCP, mcph, and session in mixed mode', () => {
    const plain = stripAnsi(formatText(mixedResult()));
    expect(plain).toContain('Context Files');
    expect(plain).toContain('MCP Configs');
    expect(plain).toContain('mcph Configs');
    expect(plain).toContain('Session Audit');
  });

  it('places the .mcph.json file under the mcph header (not under Context Files)', () => {
    const plain = stripAnsi(formatText(mixedResult()));
    const contextIdx = plain.indexOf('Context Files');
    const mcpIdx = plain.indexOf('MCP Configs');
    const mcphIdx = plain.indexOf('mcph Configs');

    // `.mcph.json` appears twice in the rendered output: once in the top
    // file-summary, once under its bold group header in the issue section.
    // The bug guard is specifically about the second occurrence — the
    // per-file ISSUE rendering — landing under the right header. Anchor the
    // search at the mcph header so we're testing the issue-section copy.
    const underMcphHeader = plain.indexOf('.mcph.json', mcphIdx);
    expect(underMcphHeader).toBeGreaterThan(mcphIdx);

    // Pre-fix, the same row rendered between the "Context Files" header and
    // the "MCP Configs" header (because the classifier treated mcph as
    // context). The context issue-section must now be mcph-free.
    const contextSection = plain.slice(contextIdx, mcpIdx);
    expect(contextSection).not.toContain('.mcph.json');
  });

  it('places the session synthetic bucket under the Session Audit header', () => {
    const plain = stripAnsi(formatText(mixedResult()));
    const sessionIdx = plain.indexOf('Session Audit');
    const sessionFileIdx = plain.indexOf('~/.claude/ (session audit)', sessionIdx);
    // The session bucket must appear AFTER its own header, never inside the
    // context issue section (between the "Context Files" and "MCP Configs"
    // headers). Pre-fix, session checks ended up routed to the context group.
    expect(sessionFileIdx).toBeGreaterThan(sessionIdx);
    const contextHeaderIdx = plain.indexOf('Context Files');
    const mcpHeaderIdx = plain.indexOf('MCP Configs');
    const contextSection = plain.slice(contextHeaderIdx, mcpHeaderIdx);
    expect(contextSection).not.toContain('~/.claude/ (session audit)');
  });

  it('routes session bucket via SESSION_AUDIT_PATH_MARKER, not the full label string', () => {
    // Re-skin the label: same `(session audit)` marker, different surrounding
    // path. The classifier should still route to the Session Audit header.
    // Use a non-session check on this row so the issue-prefix arm of the
    // classifier can't satisfy the routing -- only the path-marker arm can.
    // Need at least one other group with issues so headers render at all
    // (single-group results render flat without headers).
    const result = makeResult({
      files: [
        {
          path: 'CLAUDE.md',
          isSymlink: false,
          tokens: 100,
          lines: 5,
          issues: [{ severity: 'error', check: 'paths', line: 1, message: 'context filler' }],
        },
        {
          path: '$HOME/.claude/ (session audit)',
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [
            {
              severity: 'info',
              check: 'paths',
              line: 0,
              message: 'reskinned session-audit label',
            },
          ],
        },
      ],
      summary: { errors: 1, warnings: 0, info: 1, totalTokens: 100, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    const sessionIdx = plain.indexOf('Session Audit');
    expect(sessionIdx).toBeGreaterThan(-1);
    const rowIdx = plain.indexOf('$HOME/.claude/ (session audit)', sessionIdx);
    expect(rowIdx).toBeGreaterThan(sessionIdx);
    // Sanity: the reskinned row didn't land in the context section.
    const contextIdx = plain.indexOf('Context Files');
    if (contextIdx > -1 && sessionIdx > contextIdx) {
      const contextSection = plain.slice(contextIdx, sessionIdx);
      expect(contextSection).not.toContain('$HOME/.claude/ (session audit)');
    }
  });

  it('renders flat (no bold headers) when only one group has issues', () => {
    const result = makeResult({
      files: [
        {
          path: '.mcph.json',
          isSymlink: false,
          tokens: 20,
          lines: 3,
          issues: [
            {
              severity: 'warning',
              check: 'mcph-token-security',
              line: 2,
              message: 'token in mcph file',
            },
          ],
        },
      ],
      summary: { errors: 0, warnings: 1, info: 0, totalTokens: 20, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    // No "Context Files" / "MCP Configs" headers when only one group is present.
    expect(plain).not.toContain('Context Files');
    expect(plain).not.toContain('MCP Configs');
    // The mcph file's content still renders.
    expect(plain).toContain('.mcph.json');
    expect(plain).toContain('token in mcph file');
  });
});

describe('formatText — top-summary for synthetic audit buckets', () => {
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  // The session bucket is synthetic (SESSION_AUDIT_LABEL, path starting with
  // '~', filtered out of the real-file summaries). A clean --session-only run
  // must show "Session audit scanned" rather than the misleading "Found N
  // files" fallback.
  it('prints "Session audit scanned" for a session-only result (no "Found N files" fallback)', () => {
    const result = makeResult({
      files: [
        {
          path: SESSION_AUDIT_LABEL,
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [
            { severity: 'info', check: 'session-stale-memory', line: 0, message: 'stale memory' },
          ],
        },
      ],
      summary: { errors: 0, warnings: 0, info: 1, totalTokens: 0, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    expect(plain).toContain('Session audit scanned');
    expect(plain).not.toContain('Found 1 file');
  });

  // Mirror of the session case: a clean --skills-only run must show "Skill
  // audit scanned", not fall through to "Found N files". The skill bucket is
  // synthetic too (SKILL_AUDIT_LABEL, path starting with '~').
  it('prints "Skill audit scanned" for a skill-only result (no "Found N files" fallback)', () => {
    const result = makeResult({
      files: [
        {
          path: SKILL_AUDIT_LABEL,
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [
            {
              severity: 'warning',
              check: 'skill-trigger-collision',
              line: 0,
              message: 'two skills share a trigger',
            },
          ],
        },
      ],
      summary: { errors: 0, warnings: 1, info: 0, totalTokens: 0, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    expect(plain).toContain('Skill audit scanned');
    expect(plain).not.toContain('Found 1 file');
    // The finding still renders in the issue section.
    expect(plain).toContain('two skills share a trigger');
  });
});
