import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAudit } from '../audit.js';
import { applyFixes } from '../fixer.js';
import { formatJson, formatSarif, formatText, formatTokenReport } from '../reporter.js';
import { VERSION } from '../../version.js';
import { auditText } from '../../mcp/server.js';
import { _resetRedundancyCachesForTesting } from '../checks/redundancy.js';
import { resetPathsCache } from '../checks/paths.js';
import type { IgnoreRule } from '../ignore-rules.js';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');
// Pinned from the fixture: two tech-mention findings at ~9 tokens each.
const ESTIMATED_WASTE_REDUNDANT_CONTENT = 18;

describe('runAudit estimatedWaste', () => {
  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
  });

  it('sums wastedTokens from redundancy findings into summary.estimatedWaste', async () => {
    const result = await runAudit(path.join(FIXTURES, 'redundant-content'), ['redundancy']);

    // The redundant-content fixture has tech mentions inferable from
    // package.json (React / TypeScript / Express), which emit redundancy
    // findings carrying a structured `wastedTokens` field.
    const redundancyIssues = result.files.flatMap((f) =>
      f.issues.filter((i) => i.check === 'redundancy'),
    );
    expect(redundancyIssues.length).toBeGreaterThan(0);
    // The summary is exactly the sum of the structured fields -- not merely
    // positive (counting one finding, or double-counting, would also be > 0).
    // The discoverable-dir finding carries no estimate and no `~N tokens`.
    const structured = redundancyIssues.filter((i) => typeof i.wastedTokens === 'number');
    expect(structured).toHaveLength(2);
    const sum = structured.reduce((s, i) => s + i.wastedTokens!, 0);
    expect(result.summary.estimatedWaste).toBe(sum);
    expect(result.summary.estimatedWaste).toBe(ESTIMATED_WASTE_REDUNDANT_CONTENT);
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
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Root agents\n\nUse Jest for testing.\n');
    const result = await runAudit(tmpDir, ['contradictions'], { exclude: ['fixtures/**'] });
    expect(contradictionsIn(result).length).toBeGreaterThan(0);
  });
});

describe('runAudit .ctxlintignore', () => {
  let root: string;

  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-ignorefile-'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {}\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Root\n\nSee `src/root-missing.ts`.\n');
    fs.writeFileSync(path.join(root, 'sub', 'CLAUDE.md'), '# Sub\n\nSee `src/sub-missing.ts`.\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const audit = async (ignoreFile: string, noIgnoreFile = false) => {
    fs.writeFileSync(path.join(root, '.ctxlintignore'), ignoreFile);
    const result = await runAudit(root, ['paths'], { noIgnoreFile });
    const remaining = result.files.flatMap((f) => f.issues.map((i) => `${f.path}: ${i.message}`));
    return { remaining, report: result._meta?.ignoreReport };
  };

  it('a glob-scoped rule drops findings only in files its glob matches', async () => {
    const { remaining, report } = await audit('paths sub/*.md # sub docs\n');
    expect(remaining).toEqual(['CLAUDE.md: src/root-missing.ts does not exist']);
    expect(report).toEqual({ dropped: 1, unusedRules: [], rulesMissingReason: [] });
  });

  it('reports a glob-scoped rule whose glob matches a file but drops nothing', async () => {
    // Used to count as fired because its glob matched sub/CLAUDE.md.
    const { remaining, report } = await audit('tokens sub/*.md # never drops\n');
    expect(remaining).toHaveLength(2);
    expect(report?.unusedRules).toEqual([{ check: 'tokens', reason: 'never drops' }]);
  });

  it('builds the report when the only rules are glob-scoped and nothing is dropped', async () => {
    // Used to skip the report entirely, hiding both lists below.
    const { report } = await audit('paths nomatch/*.md\n');
    expect(report).toEqual({
      dropped: 0,
      unusedRules: [{ check: 'paths' }],
      rulesMissingReason: [{ check: 'paths' }],
    });
  });

  it('keeps first-matching-rule-wins across glob-scoped rules', async () => {
    // Both rules match sub/CLAUDE.md's one finding; the first drops it, so the
    // second has nothing left and is the one reported unused.
    const { remaining, report } = await audit(
      'paths sub/*.md # first\npaths sub/CLAUDE.md # second\n',
    );
    expect(remaining).toEqual(['CLAUDE.md: src/root-missing.ts does not exist']);
    expect(report?.dropped).toBe(1);
    expect(report?.unusedRules).toEqual([{ check: 'paths', reason: 'second' }]);
  });

  it('noIgnoreFile skips the file entirely', async () => {
    const { remaining, report } = await audit('paths # everything\n', true);
    expect(remaining).toHaveLength(2);
    expect(report).toBeUndefined();
  });
});

// runAudit used to keep a process-global per-file cache keyed only on
// path + mtime + size. Long-lived callers (the MCP server, the LSP) then got a
// previous call's results back: a different `checks` list replayed the first
// run's issues, and an identical second run dropped every cross-file
// "(project)" finding because cross-file checks only ran when a file changed.
describe('runAudit repeated calls in one process', () => {
  // scannedAt is a timestamp, so it legitimately differs between runs.
  const stable = (r: Awaited<ReturnType<typeof runAudit>>) => ({ ...r, scannedAt: '' });

  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
  });

  it('returns identical results, cross-file findings included, on a second identical call', async () => {
    const root = path.join(FIXTURES, 'contradictions');
    const first = await runAudit(root, ['contradictions']);
    expect(first.files.some((f) => f.path === '(project)' && f.issues.length > 0)).toBe(true);
    const second = await runAudit(root, ['contradictions']);
    expect(stable(second)).toEqual(stable(first));
  });

  it('runs the requested checks, not a previous call’s, when the checks list changes', async () => {
    const root = path.join(FIXTURES, 'broken-paths');
    await runAudit(root, ['tokens']);
    const second = await runAudit(root, ['paths']);
    const pathIssues = second.files.flatMap((f) => f.issues.filter((i) => i.check === 'paths'));
    expect(pathIssues.length).toBeGreaterThan(0);
    expect(pathIssues.some((i) => i.severity === 'error')).toBe(true);
  });
});

// Checks echo raw source text into message/suggestion/detail (tier-tokens
// quotes the directive line, commands quotes the command) and mcp-security
// carries the literal secret in fix.oldText. Every issue passes through the
// audit's finalize step, which redacts the text fields; the serializers
// redact fix.oldText. The fixer still needs the real value in-process.
describe('runAudit secret redaction', () => {
  const GHP = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  let root: string;

  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-redact-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('redacts a token quoted by tier-tokens from message, suggestion, JSON and text output', async () => {
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      `# Rules\n\nNEVER run \`curl -H "Authorization: Bearer ${GHP}" https://api.example.com\`.\n`,
    );
    const result = await runAudit(root, ['tier-tokens']);
    const issues = result.files.flatMap((f) => f.issues);
    const hit = issues.find((i) => i.ruleId === 'tier-tokens/hard-enforcement-missing');
    expect(hit).toBeDefined();
    expect(JSON.stringify(issues)).not.toContain(GHP);
    // The 80-char message cut lands inside the token; its tail must not leak.
    expect(JSON.stringify(issues)).not.toContain(GHP.slice(0, 20));
    expect(formatJson(result)).not.toContain(GHP);
    expect(formatSarif(result)).not.toContain(GHP);
    expect(formatText(result)).not.toContain(GHP);
  });

  // Redaction used to run before ignoreRules, so a rule naming the real token
  // (as the user sees it in their own source) could never match the masked
  // message. Rules see the unredacted text; the output is still redacted.
  it('ignoreRules match against the unredacted message', async () => {
    // A check that quotes a raw token in its message (the audit's redaction
    // is the backstop for exactly such a check).
    vi.resetModules();
    vi.doMock('../checks/hook-coverage.js', () => ({
      checkHookCoverage: async () => [
        {
          severity: 'warning',
          check: 'hook-coverage',
          ruleId: 'hook-coverage/dead-hook',
          line: 1,
          message: `hook references "curl -H 'Authorization: Bearer ${GHP}'" which does not exist`,
        },
      ],
    }));
    try {
      const { runAudit: freshRunAudit } = await import('../audit.js');
      const run = async (match: string) => {
        const result = await freshRunAudit(root, ['hook-coverage'], {
          ignoreRules: [{ check: 'hook-coverage', match, reason: 'test' }],
        });
        return {
          kept: result.files.flatMap((f) => f.issues),
          unused: result._meta?.ignoreReport?.unusedRules ?? [],
        };
      };
      // A rule naming the token as written in the source fires.
      const byToken = await run(GHP.slice(0, 24));
      expect(byToken.kept).toHaveLength(0);
      expect(byToken.unused).toEqual([]);
      // A rule copied from the redacted output still fires too.
      const kept = (await run('no-such-text')).kept;
      expect(kept).toHaveLength(1);
      expect(JSON.stringify(kept)).not.toContain(GHP);
      const redactedMsg = kept[0].message;
      const escaped = redactedMsg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect((await run(escaped)).kept).toHaveLength(0);
    } finally {
      vi.doUnmock('../checks/hook-coverage.js');
      vi.resetModules();
    }
  });

  it('keeps an mcp-security fix applicable after the result was serialized', async () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    const mcpPath = path.join(root, '.mcp.json');
    fs.writeFileSync(
      mcpPath,
      `{"mcpServers":{"gh":{"command":"npx","args":["-y","gh-mcp"],"env":{"GITHUB_TOKEN":"${GHP}"}}}}\n`,
    );
    execFileSync('git', ['add', '.mcp.json'], { cwd: root });

    const result = await runAudit(root, ['mcp-security'], { mcp: true, mcpOnly: true });
    const fixIssue = result.files
      .flatMap((f) => f.issues)
      .find((i) => i.ruleId === 'mcp-security/hardcoded-api-key' && i.fix);
    expect(fixIssue).toBeDefined();

    // Every output boundary hides the token...
    expect(formatJson(result)).not.toContain(GHP);
    expect(formatSarif(result)).not.toContain(GHP);
    expect(formatText(result)).not.toContain(GHP);
    expect(auditText(result)).not.toContain(GHP);

    // ...while the in-process fix still carries it, so applying works.
    expect(fixIssue!.fix!.oldText).toBe(GHP);
    const summary = applyFixes(result, { quiet: true });
    expect(summary.totalFixes).toBe(1);
    const after = fs.readFileSync(mcpPath, 'utf-8');
    expect(after).not.toContain(GHP);
    // The placeholder is named after the env key it replaces.
    expect(after).toContain('${GITHUB_TOKEN}');
  });
});

describe('runAudit call-site wiring', () => {
  let root: string;
  const norm = (p: string) => p.replace(/\\/g, '/');

  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-wiring-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('names the file in a malformed-directive warning', async () => {
    fs.mkdirSync(path.join(root, 'sub'));
    fs.writeFileSync(
      path.join(root, 'sub', 'CLAUDE.md'),
      '# Sub\n\n<!-- ctxlint-ignore-nextline -->\nSome text.\n',
    );
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    await runAudit(root, ['paths']);
    const warning = errors.find((e) => e.includes('unrecognized ctxlint directive'));
    expect(warning).toBeDefined();
    expect(warning).toContain('sub/CLAUDE.md:3');
  });

  it('counts a symlinked AGENTS.md -> CLAUDE.md once (aggregate and totalTokens)', async (ctx) => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), `# Rules\n\n${'Keep it short. '.repeat(40)}\n`);
    try {
      fs.symlinkSync('CLAUDE.md', path.join(root, 'AGENTS.md'));
    } catch {
      ctx.skip(); // no symlink privilege (Windows without developer mode)
    }
    const result = await runAudit(root, ['tokens'], { tokenThresholds: { aggregate: 1 } });
    const claude = result.files.find((f) => f.path === 'CLAUDE.md')!;
    const agents = result.files.find((f) => f.path === 'AGENTS.md')!;
    expect(agents.isSymlink).toBe(true);
    // One file's worth of content: below the "N files combined" bar of 2.
    const aggregate = result.files
      .flatMap((f) => f.issues)
      .filter((i) => i.ruleId === 'tokens/aggregate');
    expect(aggregate).toEqual([]);
    expect(result.summary.totalTokens).toBe(claude.tokens);
  });

  it('drops MCP configs matched by the exclude option', async () => {
    const cfg = '{"mcpServers":{"a":{"command":"node","args":["x.js"]}}}\n';
    fs.writeFileSync(path.join(root, '.mcp.json'), cfg);
    fs.mkdirSync(path.join(root, '.cursor'));
    fs.writeFileSync(path.join(root, '.cursor', 'mcp.json'), cfg);
    const result = await runAudit(root, ['mcp-schema'], {
      mcp: true,
      exclude: ['.cursor/**'],
    });
    const paths = result.files.map((f) => norm(f.path));
    expect(paths).toContain('.mcp.json');
    expect(paths).not.toContain('.cursor/mcp.json');
  });

  it('files hook-coverage findings under the settings file, not (project)', async () => {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(
      path.join(root, '.claude', 'settings.local.json'),
      JSON.stringify(
        {
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash ./.claude/hooks/gone.sh' }] }],
          },
        },
        null,
        2,
      ),
    );
    const result = await runAudit(root, ['hook-coverage']);
    const bucket = result.files.find((f) => f.path === '.claude/settings.local.json');
    expect(bucket).toBeDefined();
    expect(bucket!.issues.map((i) => i.ruleId)).toEqual(['hook-coverage/dead-hook']);
    expect(bucket!.issues[0].line).toBeGreaterThan(1);
    expect(result.files.some((f) => f.path === '(project)')).toBe(false);
  });

  // The settings file used to be parsed back out of the message's
  // "(in <path>)" text, so rewording the message misrouted the finding to
  // "(project)". The structured issue.file is what routes it now.
  it('routes hook-coverage findings by issue.file, whatever the message says', async () => {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{}\n');
    vi.resetModules();
    vi.doMock('../checks/hook-coverage.js', () => ({
      checkHookCoverage: async () => [
        {
          severity: 'warning',
          check: 'hook-coverage',
          ruleId: 'hook-coverage/dead-hook',
          line: 1,
          file: '.claude/settings.local.json',
          message: 'a reworded message that names no file at all',
        },
      ],
    }));
    try {
      const { runAudit: freshRunAudit } = await import('../audit.js');
      const result = await freshRunAudit(root, ['hook-coverage']);
      const bucket = result.files.find((f) => f.path === '.claude/settings.local.json');
      expect(bucket?.issues.map((i) => i.message)).toEqual([
        'a reworded message that names no file at all',
      ]);
      expect(result.files.some((f) => f.path === '(project)')).toBe(false);
    } finally {
      vi.doUnmock('../checks/hook-coverage.js');
      vi.resetModules();
    }
  });
});

// summary.totalTokens is "loaded every session": context files only. MCP
// configs are not prompt content, so a --mcp run must not inflate the total,
// and every output format must print the same number.
describe('runAudit token totals agree across formats', () => {
  let root: string;
  // eslint-disable-next-line no-control-regex
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  beforeEach(() => {
    _resetRedundancyCachesForTesting();
    resetPathsCache();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-totals-'));
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Rules\n\nUse the build script.\n');
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      '{"mcpServers":{"a":{"command":"node","args":["server-with-a-long-name.js"]}}}\n',
    );
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('text, --tokens, JSON and MCP output report the context-only total', async () => {
    const result = await runAudit(root, ['tokens', 'mcp-schema'], { mcp: true });
    const claude = result.files.find((f) => f.path === 'CLAUDE.md')!;
    const mcp = result.files.find((f) => f.path === '.mcp.json')!;
    expect(mcp.tokens).toBeGreaterThan(0);
    const n = claude.tokens;
    expect(result.summary.totalTokens).toBe(n);
    expect(JSON.parse(formatJson(result)).summary.totalTokens).toBe(n);
    expect(JSON.parse(auditText(result)).summary.totalTokens).toBe(n);
    const text = plain(formatText(result));
    expect(text).toContain(`Found 1 context file (${n.toLocaleString()} tokens total)`);
    expect(text).toContain(`Token usage: ${n.toLocaleString()} tokens per agent session`);
    const report = plain(formatTokenReport(result));
    expect(report).toMatch(new RegExp(`Total\\s+${n.toLocaleString()}\\b`));
    // The MCP config is not a context file, so it is not a token-table row.
    expect(report).not.toContain('.mcp.json');
  });
});

// A stale global CLI scanning a ctxlint checkout reports results the checkout
// may already have fixed. The audit detects it; every format carries it.
describe('runAudit version skew', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-skew-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a ctxlint checkout whose version differs from the running one', async () => {
    // BOM-prefixed, as PowerShell writes it.
    fs.writeFileSync(
      path.join(root, 'package.json'),
      '\uFEFF{"name":"@yawlabs/ctxlint","version":"0.0.1"}',
    );
    const result = await runAudit(root, ['paths']);
    expect(result.versionSkew).toEqual({ checkoutVersion: '0.0.1', runningVersion: VERSION });
    expect(JSON.parse(formatJson(result)).versionSkew).toEqual(result.versionSkew);
    const mcp = JSON.parse(auditText(result));
    expect(Object.keys(mcp).slice(0, 2)).toEqual(['summary', 'versionSkew']);
    expect(formatText(result)).toContain(`this checkout is v0.0.1 -- you are running v${VERSION}`);
  });

  it('is absent for another package or a matching version', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"other","version":"0.0.1"}');
    expect((await runAudit(root, ['paths'])).versionSkew).toBeUndefined();
    fs.writeFileSync(path.join(root, 'package.json'), `{"name":"ctxlint","version":"${VERSION}"}`);
    const same = await runAudit(root, ['paths']);
    expect(same.versionSkew).toBeUndefined();
    expect(Object.keys(JSON.parse(formatJson(same)))).not.toContain('versionSkew');
  });
});
