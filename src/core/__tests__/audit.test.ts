import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
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

describe('runAudit exclude', () => {
  let tmpDir: string;

  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-exclude-'));
    // Two context files that contradict each other, both under fixtures/.
    // Their conflict is reported project-wide, against the literal '(project)'
    // path -- the finding class that no per-file suppression can reach.
    fs.mkdirSync(path.join(tmpDir, 'fixtures', 'contradicting'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'fixtures', 'contradicting', 'AGENTS.md'),
      '# A\n\nUse Jest for testing.\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, 'fixtures', 'contradicting', 'CLAUDE.md'),
      '# B\n\nUse Vitest for testing.\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const contradictionsIn = (result: Awaited<ReturnType<typeof runAudit>>) =>
    result.files.flatMap((f) => f.issues.filter((i) => i.check === 'contradictions'));

  it('control: without exclude the cross-file conflict is reported at (project)', async () => {
    const result = await runAudit(tmpDir, ['contradictions']);
    expect(contradictionsIn(result).length).toBeGreaterThan(0);
    expect(result.files.some((f) => f.path === '(project)')).toBe(true);
  });

  it('removes excluded files from the corpus, silencing the (project) finding', async () => {
    // The point of excluding at SCAN time rather than suppressing findings:
    // the cross-file checks compare only what discovery returned, so dropping
    // both operands is what makes the project-level conflict go away.
    const result = await runAudit(tmpDir, ['contradictions'], { exclude: ['fixtures/**'] });
    expect(contradictionsIn(result)).toHaveLength(0);
    const norm = (p: string) => p.replace(/\\/g, '/');
    expect(result.files.some((f) => norm(f.path).startsWith('fixtures/'))).toBe(false);
  });

  it('still reports a conflict when only one operand is excluded', async () => {
    // Negative control: exclusion must not be a blanket off-switch for the
    // check. A file left in the corpus that conflicts with a NON-excluded
    // sibling is still reported.
    fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Root\n\nUse Vitest for testing.\n');
    fs.writeFileSync(
      path.join(tmpDir, 'AGENTS.md'),
      '# Root agents\n\nUse Jest for testing.\n',
    );
    const result = await runAudit(tmpDir, ['contradictions'], { exclude: ['fixtures/**'] });
    expect(contradictionsIn(result).length).toBeGreaterThan(0);
  });
});
