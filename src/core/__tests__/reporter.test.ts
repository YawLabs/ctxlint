import { describe, it, expect } from 'vitest';
import { formatText, formatJson, formatTokenReport, formatSarif } from '../reporter.js';
import { VERSION as PKG_VERSION } from '../../version.js';
import type { LintResult } from '../types.js';

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

  it('exposes rule descriptors in the tool driver for all ctxlint check categories', () => {
    const parsed = JSON.parse(formatSarif(makeResult()));
    const ruleIds = parsed.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ruleIds).toContain('ctxlint/paths');
    expect(ruleIds).toContain('ctxlint/tokens');
    expect(ruleIds).toContain('ctxlint/contradictions');
  });
});
