import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { runAudit } from '../audit.js';
import { _resetRedundancyCachesForTesting } from '../checks/redundancy.js';
import { resetPathsCache } from '../checks/paths.js';
import type { IgnoreRule } from '../ignore-rules.js';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');

describe('runAudit estimatedWaste', () => {
  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
  });

  it('sums wastedTokens from redundancy findings (summary.estimatedWaste > 0)', async () => {
    const result = await runAudit(path.join(FIXTURES, 'redundant-content'), ['redundancy']);

    // The redundant-content fixture has tech mentions inferable from
    // package.json (React / TypeScript / Express), which emit redundancy
    // findings carrying a structured `wastedTokens` field.
    const redundancyIssues = result.files.flatMap((f) =>
      f.issues.filter((i) => i.check === 'redundancy'),
    );
    expect(redundancyIssues.length).toBeGreaterThan(0);
    expect(redundancyIssues.some((i) => typeof i.wastedTokens === 'number')).toBe(true);

    expect(result.summary.estimatedWaste).toBeGreaterThan(0);
  });
});

describe('runAudit ignoreRules validation', () => {
  it('rejects with a contextual error (rule index + field + pattern) on an invalid ignoreRules regex', async () => {
    // The eager compileRules pass at the top of runAudit fails the audit
    // before any checks run; previously the bare SyntaxError surfaced from
    // applyIgnoreRules only after the whole audit had completed.
    await expect(
      runAudit(path.join(FIXTURES, 'healthy-project'), ['paths'], {
        ignoreRules: [{ check: 'paths', match: '[' }],
      }),
    ).rejects.toThrowError(/Invalid regex in ignoreRules\[0\]\.match \("\["\)/);
  });
});

describe('runAudit ignoreRules partitioning', () => {
  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
  });

  it('routes structurally-identical findings in different files to their own buckets', async () => {
    // Two fixtures whose CLAUDE.md emit the SAME redundancy finding
    // (same check / line / message) for "React". When suppression is applied
    // across the flattened stream, an index-based keep-mask must keep each
    // file's surviving findings in that file's own bucket -- a Set keyed on
    // object identity would have worked here by accident, but a Set keyed on
    // structural identity (check+line+message) would mis-route. This guards
    // the index-based partition in audit.ts.
    const root = path.join(FIXTURES, 'identical-redundancy');

    // Drop the Express mention everywhere; keep React in both files.
    const ignoreRules: IgnoreRule[] = [
      { check: 'redundancy', match: 'Express', reason: 'test: drop express only' },
    ];

    const result = await runAudit(root, ['redundancy'], { ignoreRules });

    // Separator-agnostic: path.relative yields backslashes on Windows.
    const norm = (p: string) => p.replace(/\\/g, '/');
    const fileA = result.files.find((f) => norm(f.path).startsWith('a/'));
    const fileB = result.files.find((f) => norm(f.path).startsWith('b/'));
    expect(fileA).toBeDefined();
    expect(fileB).toBeDefined();

    // Each file keeps its OWN React finding -- not both collapsed into one
    // bucket, not zero because a structural-identity Set deduped them.
    const reactInA = fileA!.issues.filter((i) => i.message.includes('React'));
    const reactInB = fileB!.issues.filter((i) => i.message.includes('React'));
    expect(reactInA).toHaveLength(1);
    expect(reactInB).toHaveLength(1);

    // The Express finding was dropped from both files.
    const expressAnywhere = result.files.flatMap((f) =>
      f.issues.filter((i) => i.message.includes('Express')),
    );
    expect(expressAnywhere).toHaveLength(0);
    expect(result._meta?.ignoreReport?.dropped).toBeGreaterThan(0);
  });
});
