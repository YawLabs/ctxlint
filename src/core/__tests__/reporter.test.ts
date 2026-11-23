import { describe, it, expect } from 'vitest';
import {
  formatText,
  formatJson,
  formatTokenReport,
  formatSarif,
  redactLiteralCredentials,
  redactResultForOutput,
} from '../reporter.js';
import { ALL_CHECKS, ALL_MCP_CHECKS, ALL_SESSION_CHECKS, ALL_SKILL_CHECKS } from '../audit.js';
import { VERSION as PKG_VERSION } from '../../version.js';
import {
  SESSION_AUDIT_LABEL,
  SESSION_AUDIT_PATH_MARKER,
  SKILL_AUDIT_LABEL,
  SKILL_AUDIT_PATH_MARKER,
  type LintResult,
} from '../types.js';

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

  // Synthetic cross-file buckets ((project), (mcp), ~/.claude/ (session audit))
  // carry 0 tokens / 0 lines and must not render as table rows -- they are not
  // files the user authored. They also must not widen the File column.
  it('omits synthetic cross-file buckets from the token table', () => {
    const result = makeResult({
      files: [
        { path: 'CLAUDE.md', isSymlink: false, tokens: 500, lines: 20, issues: [] },
        {
          path: '(project)',
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [{ severity: 'warning', check: 'contradictions', line: 0, message: 'x' }],
        },
        {
          path: SESSION_AUDIT_LABEL,
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [{ severity: 'info', check: 'session-stale-memory', line: 0, message: 'y' }],
        },
      ],
      summary: { errors: 0, warnings: 1, info: 1, totalTokens: 500, estimatedWaste: 0 },
    });
    const output = formatTokenReport(result);
    // Real file row still present.
    expect(output).toContain('CLAUDE.md');
    // Synthetic buckets are filtered out of the rows.
    expect(output).not.toContain('(project)');
    expect(output).not.toContain(SESSION_AUDIT_LABEL);
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
  // so the label must never become `physicalLocation.artifactLocation.uri`
  // (GitHub would file it against a literal "(project)" path). It goes in
  // `logicalLocations`; GitHub code scanning requires a physicalLocation on
  // every result, so a real file of the run anchors it.
  it('labels synthetic buckets as logicalLocations and anchors them on a real file', () => {
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

    // Synthetic project bucket: the label is a logical location, the root
    // context file the physical one (line 1: the finding's line is not one
    // of that file's lines).
    expect(projectResult.locations[0].logicalLocations[0].name).toBe('(project)');
    expect(projectResult.locations[0].physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    expect(projectResult.locations[0].physicalLocation.region.startLine).toBe(1);

    // Synthetic session bucket: same treatment. Leading `~` is the tell.
    expect(sessionResult.locations[0].logicalLocations[0].name).toBe('~/.claude/ (session audit)');
    expect(sessionResult.locations[0].physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    for (const r of parsed.runs[0].results) {
      expect(r.locations[0].physicalLocation.artifactLocation.uri).not.toMatch(/[()~ ]/);
    }

    // Real file path — unchanged, still uses physicalLocation (regression guard).
    expect(fileResult.locations[0].physicalLocation.artifactLocation.uri).toBe('CLAUDE.md');
    expect(fileResult.locations[0].physicalLocation.region.startLine).toBe(3);
    expect(fileResult.locations[0].logicalLocations).toBeUndefined();
  });

  // Regression: a reskinned synthetic label that carries the (session audit)
  // marker but does NOT start with '~' (e.g. '$HOME/.claude/ (session audit)')
  // must still be treated as synthetic -- otherwise it leaks into a SARIF
  // physicalLocation.artifactLocation.uri and GitHub Code Scanning files it as
  // a literal repo-relative path. isSyntheticPath keys off the marker, not the
  // leading '~'.
  it('uses logicalLocations for a marker-bearing label that does not start with ~', () => {
    const reskinned = '$HOME/.claude/ (session audit)';
    const result = makeResult({
      files: [
        {
          path: reskinned,
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [
            { severity: 'info', check: 'session-stale-memory', line: 0, message: 'stale memory' },
          ],
        },
      ],
    });
    const parsed = JSON.parse(formatSarif(result));
    const sessionResult = parsed.runs[0].results[0];
    expect(sessionResult.locations[0].physicalLocation).toBeUndefined();
    expect(sessionResult.locations[0].logicalLocations[0].name).toBe(reskinned);
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
  // and `session-memory-index-overflow` between v0.9.2 and v0.9.5. Keep all
  // four catalogs in sync with the constant lists in audit.ts.
  it('SARIF descriptors cover every check in ALL_CHECKS / ALL_MCP_CHECKS / ALL_SESSION_CHECKS / ALL_SKILL_CHECKS', () => {
    // Imported at module top — `await import()` here used to occasionally
    // time out under parallel test load while waiting for the audit module's
    // tiktoken/zod/etc. import chain to resolve.
    const parsed = JSON.parse(formatSarif(makeResult()));
    const ruleIds: string[] = parsed.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    const expected = [
      ...ALL_CHECKS,
      ...ALL_MCP_CHECKS,
      ...ALL_SESSION_CHECKS,
      ...ALL_SKILL_CHECKS,
    ].map((c: string) => `ctxlint/${c}`);
    const missing = expected.filter((id) => !ruleIds.includes(id));
    expect(missing).toEqual([]);
  });

  it('emits the specific ruleId and a descriptor for every ruleId it uses', () => {
    const result = makeResult({
      files: [
        {
          path: 'CLAUDE.md',
          isSymlink: false,
          tokens: 10,
          lines: 1,
          issues: [
            {
              severity: 'warning',
              check: 'tokens',
              ruleId: 'tokens/aggregate',
              line: 0,
              message: 'a',
            },
            { severity: 'error', check: 'paths', line: 2, message: 'no ruleId' },
          ],
        },
      ],
    });
    const run = JSON.parse(formatSarif(result)).runs[0];
    expect(run.results.map((r: { ruleId: string }) => r.ruleId)).toEqual([
      'ctxlint/tokens/aggregate',
      'ctxlint/paths',
    ]);
    const rules = run.tool.driver.rules as { id: string; shortDescription: { text: string } }[];
    const ids = rules.map((r) => r.id);
    for (const r of run.results) expect(ids).toContain(r.ruleId);
    expect(new Set(ids).size).toBe(ids.length);
    // A specific rule inherits its family's description.
    const family = rules.find((r) => r.id === 'ctxlint/tokens')!;
    const specific = rules.find((r) => r.id === 'ctxlint/tokens/aggregate')!;
    expect(specific.shortDescription).toEqual(family.shortDescription);
  });

  it('percent-encodes the artifact uri and uses forward slashes', () => {
    const result = makeResult({
      files: [
        {
          path: 'docs\\my notes#1\\CLAUDE.md',
          isSymlink: false,
          tokens: 10,
          lines: 1,
          issues: [{ severity: 'error', check: 'paths', line: 1, message: 'x' }],
        },
      ],
    });
    const r = JSON.parse(formatSarif(result)).runs[0].results[0];
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe(
      'docs/my%20notes%231/CLAUDE.md',
    );
  });

  it('anchors (mcp) findings on the MCP config and (project) on the shallowest context file', () => {
    const issue = { severity: 'warning' as const, line: 0, message: 'x' };
    const result = makeResult({
      files: [
        { path: 'sub/CLAUDE.md', isSymlink: false, tokens: 1, lines: 1, issues: [] },
        { path: 'AGENTS.md', isSymlink: false, tokens: 1, lines: 1, issues: [] },
        { path: '.cursor/mcp.json', isSymlink: false, tokens: 1, lines: 1, issues: [] },
        {
          path: '(project)',
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [{ ...issue, check: 'contradictions' }],
        },
        {
          path: '(mcp)',
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [{ ...issue, check: 'mcp-consistency' }],
        },
      ],
    });
    const [project, mcp] = JSON.parse(formatSarif(result)).runs[0].results;
    expect(project.locations[0].physicalLocation.artifactLocation.uri).toBe('AGENTS.md');
    expect(mcp.locations[0].physicalLocation.artifactLocation.uri).toBe('.cursor/mcp.json');
  });

  it('keeps logicalLocations only when the run has no real file to anchor on', () => {
    const result = makeResult({
      files: [
        {
          path: SESSION_AUDIT_LABEL,
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [{ severity: 'info', check: 'session-stale-memory', line: 0, message: 's' }],
        },
      ],
    });
    const r = JSON.parse(formatSarif(result)).runs[0].results[0];
    expect(r.locations[0].physicalLocation).toBeUndefined();
    expect(r.locations[0].logicalLocations[0].name).toBe(SESSION_AUDIT_LABEL);
  });
});

describe('formatText version skew', () => {
  it('renders the skew the audit detected, and nothing without it', () => {
    const skewed = {
      ...makeResult(),
      versionSkew: { checkoutVersion: '9.9.9', runningVersion: '1.0.0' },
    };
    expect(formatText(skewed)).toContain('this checkout is v9.9.9 -- you are running v1.0.0');
    expect(formatText(makeResult())).not.toContain('this checkout is');
  });
});

describe('formatText — group classification', () => {
  // `'session-*'` doesn't start with `mcp-`, so the classifier must not route
  // session rows into the MCP bucket. The pre-fix classifier used a single
  // `mcp-` prefix test as the splitter, so session rows ended up under the
  // bold "Context Files" header in mixed-mode output. This test guards the
  // multi-group classifier.
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
      summary: { errors: 2, warnings: 0, info: 1, totalTokens: 130, estimatedWaste: 0 },
    });
  }

  it('renders bold group headers for context, MCP, and session in mixed mode', () => {
    const plain = stripAnsi(formatText(mixedResult()));
    expect(plain).toContain('Context Files');
    expect(plain).toContain('MCP Configs');
    expect(plain).toContain('Session Audit');
  });

  it('places the .mcp.json file under the MCP header (not under Context Files)', () => {
    const plain = stripAnsi(formatText(mixedResult()));
    const contextIdx = plain.indexOf('Context Files');
    const mcpIdx = plain.indexOf('MCP Configs');

    // `.mcp.json` appears twice in the rendered output: once in the top
    // file-summary, once under its bold group header in the issue section.
    // The bug guard is specifically about the second occurrence — the
    // per-file ISSUE rendering — landing under the right header. Anchor the
    // search at the MCP header so we're testing the issue-section copy.
    const underMcpHeader = plain.indexOf('.mcp.json', mcpIdx);
    expect(underMcpHeader).toBeGreaterThan(mcpIdx);

    // The context issue-section must be MCP-free.
    const contextSection = plain.slice(contextIdx, mcpIdx);
    expect(contextSection).not.toContain('.mcp.json');
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

  it('routes skill bucket via SKILL_AUDIT_PATH_MARKER, not the full label string', () => {
    // Mirror of the session reskin test: same '(skill audit)' marker,
    // different surrounding path. The reporter must import the marker from
    // types.ts (next to SKILL_AUDIT_LABEL) so a label reskin can't desync
    // routing. Non-skill check on the row so only the path-marker arm of the
    // classifier can satisfy the routing.
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
          path: '$HOME/.claude/ (skill audit)',
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [
            { severity: 'info', check: 'paths', line: 0, message: 'reskinned skill-audit label' },
          ],
        },
      ],
      summary: { errors: 1, warnings: 0, info: 1, totalTokens: 100, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    const skillIdx = plain.indexOf('Skill Audit');
    expect(skillIdx).toBeGreaterThan(-1);
    const rowIdx = plain.indexOf('$HOME/.claude/ (skill audit)', skillIdx);
    expect(rowIdx).toBeGreaterThan(skillIdx);
  });

  it('keeps the path markers as substrings of their labels (routing invariant)', () => {
    // The reporter routes on the markers while audit.ts stamps the labels.
    // If a label reskin drops its marker, classification silently breaks.
    expect(SESSION_AUDIT_LABEL).toContain(SESSION_AUDIT_PATH_MARKER);
    expect(SKILL_AUDIT_LABEL).toContain(SKILL_AUDIT_PATH_MARKER);
  });

  it('classifies a clean windsurf global mcp_config.json as an MCP config, not a context file', () => {
    // scanGlobalMcpConfigs surfaces ~/.codeium/windsurf/mcp_config.json,
    // which matches none of the other path-fallback suffixes. With zero
    // issues the issue-prefix arm can't route it either, so the fallback must
    // recognize '/mcp_config.json'.
    const result = makeResult({
      files: [
        {
          path: '~/.codeium/windsurf/mcp_config.json',
          isSymlink: false,
          tokens: 40,
          lines: 6,
          issues: [],
        },
      ],
      summary: { errors: 0, warnings: 0, info: 0, totalTokens: 40, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    expect(plain).toContain('Found 1 MCP config');
    expect(plain).not.toContain('context file');
  });

  it('renders flat (no bold headers) when only one group has issues', () => {
    const result = makeResult({
      files: [
        {
          path: '.mcp.json',
          isSymlink: false,
          tokens: 20,
          lines: 3,
          issues: [
            {
              severity: 'warning',
              check: 'mcp-security',
              line: 2,
              message: 'token in mcp file',
            },
          ],
        },
      ],
      summary: { errors: 0, warnings: 1, info: 0, totalTokens: 20, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    // No "Context Files" / "MCP Configs" headers when only one group is present
    // (single-group results render flat without the bold group headers).
    expect(plain).not.toContain('Context Files');
    expect(plain).not.toContain('MCP Configs');
    // The mcp file's content still renders.
    expect(plain).toContain('.mcp.json');
    expect(plain).toContain('token in mcp file');
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

describe('formatText — context token accounting excludes MCP configs', () => {
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  // summary.totalTokens is context files only (audit.ts contextTokenTotal);
  // an MCP config keeps its own per-file count but is never loaded into agent
  // context. Text and --tokens print summary.totalTokens, the same number
  // JSON carries, and list context files only.
  it('text and the token table print summary.totalTokens and omit MCP configs', () => {
    const result = makeResult({
      files: [
        { path: 'CLAUDE.md', isSymlink: false, tokens: 500, lines: 20, issues: [] },
        { path: '.mcp.json', isSymlink: false, tokens: 300, lines: 10, issues: [] },
      ],
      summary: { errors: 0, warnings: 0, info: 0, totalTokens: 500, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    expect(plain).toContain('Found 1 context file (500 tokens total)');
    expect(plain).toContain('Token usage: 500 tokens per agent session');
    expect(plain).not.toContain('800');
    const table = stripAnsi(formatTokenReport(result));
    expect(table).toMatch(/Total\s+500\b/);
    expect(table).not.toContain('.mcp.json');
  });

  it('does not list a hook-coverage settings file as a context file', () => {
    const result = makeResult({
      files: [
        { path: 'CLAUDE.md', isSymlink: false, tokens: 500, lines: 20, issues: [] },
        {
          path: '.claude/settings.json',
          isSymlink: false,
          tokens: 0,
          lines: 12,
          issues: [{ severity: 'warning', check: 'hook-coverage', line: 4, message: 'dead hook' }],
        },
      ],
      summary: { errors: 0, warnings: 1, info: 0, totalTokens: 500, estimatedWaste: 0 },
    });
    const plain = stripAnsi(formatText(result));
    expect(plain).toContain('Found 1 context file (500 tokens total)');
    expect(plain).toContain('dead hook');
    expect(stripAnsi(formatTokenReport(result))).not.toContain('settings.json');
  });
});

describe('paren-prefixed real paths are not synthetic buckets', () => {
  function stripAnsi(s: string): string {
    // eslint-disable-next-line no-control-regex
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  // isSyntheticBucket used to treat ANY path starting with '(' as a synthetic
  // cross-file bucket, so a real context file under a paren-named directory
  // (e.g. a Next.js route group '(docs)/') was dropped from the summary, the
  // token table, and demoted to SARIF logicalLocations. Only the exact
  // '(project)' / '(mcp)' labels are synthetic.
  function parenResult(): LintResult {
    return makeResult({
      files: [
        {
          path: '(docs)/CLAUDE.md',
          isSymlink: false,
          tokens: 120,
          lines: 8,
          issues: [{ severity: 'error', check: 'paths', line: 3, message: 'missing path' }],
        },
      ],
      summary: { errors: 1, warnings: 0, info: 0, totalTokens: 120, estimatedWaste: 0 },
    });
  }

  it('lists the file in the "Found N context files" summary', () => {
    const plain = stripAnsi(formatText(parenResult()));
    expect(plain).toContain('Found 1 context file (120 tokens total)');
    expect(plain).toContain('(docs)/CLAUDE.md');
  });

  it('renders the file as a token-table row', () => {
    const output = formatTokenReport(parenResult());
    expect(output).toContain('(docs)/CLAUDE.md');
  });

  it('emits a SARIF physicalLocation (not logicalLocations) for its findings', () => {
    const parsed = JSON.parse(formatSarif(parenResult()));
    const r = parsed.runs[0].results[0];
    expect(r.locations[0].physicalLocation.artifactLocation.uri).toBe('(docs)/CLAUDE.md');
    expect(r.locations[0].physicalLocation.region.startLine).toBe(3);
    expect(r.locations[0].logicalLocations).toBeUndefined();
  });

  it('still treats the exact (project) and (mcp) labels as synthetic in the token table', () => {
    const result = makeResult({
      files: [
        { path: 'CLAUDE.md', isSymlink: false, tokens: 500, lines: 20, issues: [] },
        {
          path: '(mcp)',
          isSymlink: false,
          tokens: 0,
          lines: 0,
          issues: [{ severity: 'warning', check: 'mcp-consistency', line: 0, message: 'x' }],
        },
      ],
      summary: { errors: 0, warnings: 1, info: 0, totalTokens: 500, estimatedWaste: 0 },
    });
    const output = formatTokenReport(result);
    expect(output).not.toContain('(mcp)');
  });
});

describe('secret redaction at the output boundary', () => {
  const GHP = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  // No known prefix: only the mcp-security high-entropy heuristic flags it.
  const ENTROPY = 'Zq9wX2vB7nM4kL1pR8tY5uI3oE6aS0dF';

  function leakyResult(): LintResult {
    return makeResult({
      files: [
        {
          path: '.mcp.json',
          isSymlink: false,
          tokens: 0,
          lines: 1,
          issues: [
            {
              severity: 'error',
              check: 'mcp-security',
              ruleId: 'mcp-security/hardcoded-api-key',
              line: 1,
              message: 'Server "gh" has a hardcoded API key in a git-tracked file',
              fix: { file: '/p/.mcp.json', line: 1, oldText: GHP, newText: '${GH_API_KEY}' },
            },
            {
              severity: 'error',
              check: 'mcp-security',
              ruleId: 'mcp-security/hardcoded-api-key',
              line: 1,
              message: 'Server "db" has a hardcoded API key in a git-tracked file',
              fix: { file: '/p/.mcp.json', line: 1, oldText: ENTROPY, newText: '${DB_API_KEY}' },
            },
            {
              severity: 'info',
              check: 'tier-tokens',
              line: 2,
              // Raw text as a check emits it, before the audit choke point.
              message: `Inviolable framing ("NEVER run \`curl -H Bearer ${GHP}\`")`,
              suggestion: `For \`curl -H Bearer ${GHP}\`, add a hook`,
              detail: `cmd: ${GHP}`,
            },
          ],
        },
        {
          path: 'CLAUDE.md',
          isSymlink: false,
          tokens: 0,
          lines: 1,
          issues: [
            {
              severity: 'error',
              check: 'paths',
              line: 3,
              message: 'src/old.ts does not exist',
              fix: { file: '/p/CLAUDE.md', line: 3, oldText: 'src/old.ts', newText: 'src/new.ts' },
            },
          ],
        },
      ],
    });
  }

  it('formatJson omits secret fix values (pattern and entropy) and secret text', () => {
    const out = formatJson(leakyResult());
    expect(out).not.toContain(GHP);
    expect(out).not.toContain(ENTROPY);
    // A non-secret fix is still reported verbatim.
    expect(out).toContain('"oldText": "src/old.ts"');
  });

  it('formatSarif omits secret text', () => {
    const out = formatSarif(leakyResult());
    expect(out).not.toContain(GHP);
  });

  it('formatText omits secret text', () => {
    const out = formatText(leakyResult());
    expect(out).not.toContain(GHP);
  });

  it('does not mutate the in-process result (the fixer needs the real oldText)', () => {
    const result = leakyResult();
    formatJson(result);
    formatSarif(result);
    formatText(result);
    expect(result.files[0].issues[0].fix!.oldText).toBe(GHP);
    expect(result.files[0].issues[1].fix!.oldText).toBe(ENTROPY);
  });

  // A fix spanning a whole value (as mcp-env/wrong-syntax fixes once did)
  // carries a literal secret sitting beside a ${VAR} ref in oldText and
  // newText. Neither literal matches a known-token pattern.
  describe('literal credentials inside a non-secret fix', () => {
    const URL_KEY = 'Qw9Er8Ty7Ui6Op5As4Df3Gh';
    const HEADER_KEY = 'Pq1Wo2Ei3Ru4Ty5Yu6Io7Pa8Sd9Fg0Hj';
    const USER_PW = 'hunter2pw';

    function envFixResult(): LintResult {
      const fix = (oldText: string, newText: string) => ({
        file: '/p/.cursor/mcp.json',
        line: 4,
        oldText,
        newText,
      });
      return makeResult({
        files: [
          {
            path: '.cursor/mcp.json',
            isSymlink: false,
            tokens: 0,
            lines: 10,
            issues: [
              {
                severity: 'warning',
                check: 'mcp-env',
                ruleId: 'mcp-env/wrong-syntax',
                line: 4,
                message: 'Server "api": wrong env var syntax for cursor',
                fix: fix(
                  `https://api.example.com/mcp?api_key=${URL_KEY}&ws=\${WORKSPACE}`,
                  `https://api.example.com/mcp?api_key=${URL_KEY}&ws=\${env:WORKSPACE}`,
                ),
              },
              {
                severity: 'warning',
                check: 'mcp-env',
                ruleId: 'mcp-env/wrong-syntax',
                line: 6,
                message: 'Server "api": wrong env var syntax for cursor',
                fix: fix(`${HEADER_KEY}\${SUFFIX}`, `${HEADER_KEY}\${env:SUFFIX}`),
              },
              {
                severity: 'warning',
                check: 'mcp-env',
                ruleId: 'mcp-env/wrong-syntax',
                line: 8,
                message: 'Server "db": wrong env var syntax for cursor',
                fix: fix(
                  `postgres://admin:${USER_PW}@\${DB_HOST}/app`,
                  `postgres://admin:${USER_PW}@\${env:DB_HOST}/app`,
                ),
              },
            ],
          },
        ],
      });
    }

    it('formatJson masks literal secrets in the fix text but keeps the env refs', () => {
      const out = formatJson(envFixResult());
      expect(out).not.toContain(URL_KEY);
      expect(out).not.toContain(HEADER_KEY);
      expect(out).not.toContain(USER_PW);
      // The part the fix actually changes stays readable.
      expect(out).toContain('&ws=${env:WORKSPACE}');
      expect(out).toContain('${env:SUFFIX}');
      expect(out).toContain('@${env:DB_HOST}/app');
    });

    it('redactResultForOutput (the MCP audit tools) masks them too', () => {
      const out = JSON.stringify(redactResultForOutput(envFixResult()));
      expect(out).not.toContain(URL_KEY);
      expect(out).not.toContain(HEADER_KEY);
      expect(out).not.toContain(USER_PW);
    });

    it('leaves ordinary fix text alone', () => {
      expect(redactLiteralCredentials('https://api.example.com/mcp?ws=${WORKSPACE}')).toBe(
        'https://api.example.com/mcp?ws=${WORKSPACE}',
      );
      expect(redactLiteralCredentials('@modelcontextprotocol/server-filesystem')).toBe(
        '@modelcontextprotocol/server-filesystem',
      );
      expect(redactLiteralCredentials('src/old.ts')).toBe('src/old.ts');
      // A query secret that is entirely an env ref is not a literal.
      expect(redactLiteralCredentials('https://x.dev/?token=${TOKEN}')).toBe(
        'https://x.dev/?token=${TOKEN}',
      );
    });
  });
});
