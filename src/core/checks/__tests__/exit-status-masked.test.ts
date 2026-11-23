import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkCommands } from '../commands.js';
import {
  analyzeMaskedExitStatus,
  fenceBlocks,
  pipefailInScope,
  splitPipes,
  splitSegments,
  verifierName,
  filterName,
} from '../exit-status.js';
import { resetPackageJsonCache } from '../../../utils/fs.js';
import type { DiscoveredFile } from '../../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');
const RULE = 'commands/exit-status-masked';

describe('splitSegments / splitPipes', () => {
  it('splits on top-level && ; ||', () => {
    expect(splitSegments('a && b ; c || d').map((s) => [s.op, s.text])).toEqual([
      ['', 'a'],
      ['&&', 'b'],
      [';', 'c'],
      ['||', 'd'],
    ]);
  });

  it('does not split operators inside quotes', () => {
    const segs = splitSegments(`echo "a && b" && echo 'c ; d'`);
    expect(segs).toHaveLength(2);
    expect(segs[0].text).toBe(`echo "a && b"`);
    expect(segs[1].text).toBe(`echo 'c ; d'`);
  });

  it('splits pipes but leaves quoted pipes alone', () => {
    expect(splitPipes(`grep "a|b" foo | head -5`)).toEqual([`grep "a|b" foo`, 'head -5']);
  });
});

describe('verifierName / filterName', () => {
  it('unwraps npx and leading env assignments', () => {
    expect(verifierName('npx -y biome check src/')).toBe('biome');
    expect(verifierName('CI=1 FORCE_COLOR=0 npx tsc --noEmit')).toBe('tsc');
    expect(verifierName('pnpm exec vitest run')).toBe('vitest');
  });

  it('matches two-token verifiers', () => {
    expect(verifierName('cargo test --all')).toBe('cargo test');
    expect(verifierName('go test ./...')).toBe('go test');
  });

  it('resolves one level of script indirection', () => {
    expect(verifierName('npm run typecheck', { typecheck: 'tsc --noEmit' })).toBe('tsc');
    expect(verifierName('npm test', { test: 'vitest run' })).toBe('vitest');
  });

  it("resolves all of npm's lifecycle shorthands, and only those", () => {
    expect(verifierName('npm tst', { test: 'vitest run' })).toBe('vitest');
    expect(verifierName('npm t', { test: 'vitest run' })).toBe('vitest');
    // npm runs no script for `npm lint` / `npm test-unit`.
    expect(verifierName('npm lint', { lint: 'eslint .' })).toBeNull();
    expect(verifierName('npm test-unit', { 'test-unit': 'vitest run', test: 'vitest' })).toBeNull();
  });

  it('is null for non-verifiers', () => {
    expect(verifierName('git log')).toBeNull();
    expect(verifierName('npm run build', { build: 'esbuild src' })).toBeNull();
  });

  it('recognises filters, including through wrappers', () => {
    expect(filterName('head -20')).toBe('head');
    expect(filterName('tail -n 5')).toBe('tail');
    expect(filterName('sudo tail -n 5 /var/log/x')).toBe('tail');
    expect(filterName('nice -n 10 grep -q error')).toBe('grep');
    expect(filterName('node scripts/x.js')).toBeNull();
  });

  it('strips value-taking wrapper flags and the two-token `bun x` wrapper', () => {
    expect(verifierName('nice -n 10 tsc --noEmit')).toBe('tsc');
    expect(verifierName('bun x vitest run')).toBe('vitest');
    expect(verifierName('npx -p typescript tsc --noEmit')).toBe('tsc');
    // `command -v` looks a name up; it does not run it.
    expect(verifierName('command -v tsc')).toBeNull();
  });

  it('classifies `pnpm|yarn|bun <name>` as a direct command when <name> is not a script', () => {
    expect(verifierName('pnpm tsc --noEmit')).toBe('tsc');
    expect(verifierName('yarn eslint .', { build: 'tsc' })).toBe('eslint');
    expect(verifierName('bun vitest run', {})).toBe('vitest');
    // A real script still wins: `pnpm lint` reads the script body.
    expect(verifierName('pnpm lint', { lint: 'biome check .' })).toBe('biome');
    // npm does not fall back to binaries.
    expect(verifierName('npm run tsc')).toBeNull();
  });

  it('covers the refreshed verifier tables', () => {
    expect(verifierName('prettier --check .')).toBe('prettier');
    expect(verifierName('prettier --write .')).toBeNull();
    expect(verifierName('npx mocha')).toBe('mocha');
    expect(verifierName('npx playwright test')).toBe('playwright test');
    expect(verifierName('npx vue-tsc --noEmit')).toBe('vue-tsc');
    expect(verifierName('deno test -A')).toBe('deno test');
    expect(verifierName('python -m pytest -q')).toBe('python -m pytest');
    expect(verifierName('cargo build --release')).toBe('cargo build');
    expect(verifierName('bun test')).toBe('bun test');
    // A name that merely starts with a verifier's is not that verifier.
    expect(verifierName('tsc-watch --onSuccess x')).toBeNull();
  });
});

describe('analyzeMaskedExitStatus', () => {
  it('flags the && success-claim shape', () => {
    const r = analyzeMaskedExitStatus('npx tsc --noEmit | head -20 && echo "tsc clean"');
    expect(r).not.toBeNull();
    expect(r?.verifier).toBe('tsc');
    expect(r?.filter).toBe('head');
    expect(r?.kind).toBe('success-claim');
  });

  it('flags the `; echo "exit=$?"` shape, which reports the filter status', () => {
    const r = analyzeMaskedExitStatus('npx biome check src/ 2>&1 | tail -5; echo "exit=$?"');
    expect(r).not.toBeNull();
    expect(r?.verifier).toBe('biome');
    expect(r?.filter).toBe('tail');
    expect(r?.kind).toBe('status-echo');
  });

  it('flags a pipeline through a script indirection', () => {
    const r = analyzeMaskedExitStatus('npm run lint | tail -5 && echo "lint OK"', {
      lint: 'biome check src/',
    });
    expect(r?.verifier).toBe('biome');
  });

  // --- negative controls: each relaxes exactly one condition ---

  it('is silent with no filter in the pipeline', () => {
    expect(
      analyzeMaskedExitStatus('npm test && echo "tests pass"', { test: 'vitest run' }),
    ).toBeNull();
  });

  it('is silent with no success claim (reading output through a pager is normal)', () => {
    expect(analyzeMaskedExitStatus('npm test | tail -50', { test: 'vitest run' })).toBeNull();
  });

  it('is silent when the trailing echo is honest about failure', () => {
    expect(
      analyzeMaskedExitStatus('npx tsc --noEmit | grep error && echo "has errors"'),
    ).toBeNull();
  });

  it('is silent when the pipeline head is not a verifier', () => {
    expect(analyzeMaskedExitStatus('git log --oneline | head -5 && echo "done"')).toBeNull();
  });

  it('is silent on ||, which reads the failure branch', () => {
    expect(analyzeMaskedExitStatus('npx tsc --noEmit | head -5 || echo "clean"')).toBeNull();
  });

  it('is silent when an inline set -o pipefail precedes the pipeline', () => {
    expect(
      analyzeMaskedExitStatus('set -o pipefail && npx tsc --noEmit | head -20 && echo "tsc clean"'),
    ).toBeNull();
  });

  it('exempts ${PIPESTATUS[0]}, which is the documented fix', () => {
    expect(
      analyzeMaskedExitStatus('npx tsc --noEmit | head -20; echo "exit=${PIPESTATUS[0]}"'),
    ).toBeNull();
  });

  it('flags a bare-runner binary invocation (`pnpm tsc`) the same as `npx tsc`', () => {
    const r = analyzeMaskedExitStatus('pnpm tsc --noEmit | head -20 && echo "tsc clean"', {
      build: 'tsc',
    });
    expect(r?.verifier).toBe('tsc');
    expect(r?.filter).toBe('head');
  });

  it('is silent when the echo reports failure (negated success word)', () => {
    // grep finds an error -> say FAIL: a correct gate, not a success claim.
    expect(
      analyzeMaskedExitStatus('npx tsc --noEmit | grep -q "error TS" && echo "FAIL: not clean"'),
    ).toBeNull();
    expect(
      analyzeMaskedExitStatus('npx tsc --noEmit | grep error && echo "tests not passing"'),
    ).toBeNull();
    // "no errors" is itself the success phrase and still counts.
    expect(analyzeMaskedExitStatus('npx tsc --noEmit | tail -3 && echo "no errors"')?.kind).toBe(
      'success-claim',
    );
  });

  it.each([
    ['0 errors, clean'],
    ['no issues - passed'],
    ['zero failures, all good'],
    ['0 failed, 12 passed'],
    ['errors: 0 -- OK'],
  ])('still flags a zero count before the success word (%s)', (message) => {
    expect(analyzeMaskedExitStatus(`npx tsc --noEmit | tail -3 && echo "${message}"`)?.kind).toBe(
      'success-claim',
    );
  });

  it('is silent on a bare `; echo done` with no status read', () => {
    // `;` alone claims nothing about the pipeline -- only an explicit `$?` does.
    expect(analyzeMaskedExitStatus('npx tsc --noEmit | head -20; echo done')).toBeNull();
  });
});

describe('pipefailInScope', () => {
  const doc = [
    '# t',
    '',
    '```bash',
    'set -euo pipefail',
    'npx tsc | head',
    '```',
    '',
    '`tsc | head`',
  ].join('\n');

  it('sees pipefail earlier in the same fence', () => {
    expect(pipefailInScope(doc, 5)).toBe(true);
  });

  it('does not leak across fences', () => {
    const two = ['```bash', 'set -o pipefail', '```', '', '```bash', 'npx tsc | head', '```'].join(
      '\n',
    );
    expect(pipefailInScope(two, 6)).toBe(false);
  });

  it('is false outside any fence', () => {
    expect(pipefailInScope(doc, 8)).toBe(false);
  });

  it('works on CRLF files', () => {
    expect(pipefailInScope(doc.replace(/\n/g, '\r\n'), 5)).toBe(true);
  });

  it('is not fooled by a fence-looking line inside an HTML comment', () => {
    // The comment's ``` used to toggle the hand-rolled tracker, so the real
    // fence below read as CLOSED and its pipefail was never seen.
    const md = ['<!--', '```', '-->', '```bash', 'set -o pipefail', 'npx tsc | head', '```'].join(
      '\n',
    );
    expect(pipefailInScope(md, 6)).toBe(true);
  });
});

describe('fenceBlocks', () => {
  it('reads block bounds and info strings from the shared markdown mask', () => {
    const md = ['x', '```bash title', 'a', '```', '', '```', 'b'].join('\n');
    expect(fenceBlocks(md.split('\n'))).toEqual([
      { open: 1, close: 3, info: 'bash title' },
      { open: 5, close: 7, info: '' },
    ]);
  });
});

describe('checkCommands — commands/exit-status-masked on the fixture', () => {
  beforeEach(() => resetPackageJsonCache());
  afterEach(() => resetPackageJsonCache());

  function discovered(fixture: string, file: string): DiscoveredFile {
    return {
      absolutePath: path.join(FIXTURES, fixture, file),
      relativePath: file,
      isSymlink: false,
      type: 'context',
    };
  }

  it('fires on exactly the two positive cases and none of the three controls', async () => {
    const parsed = parseContextFile(discovered('masked-exit-status', 'CLAUDE.md'));
    const issues = await checkCommands(parsed, path.join(FIXTURES, 'masked-exit-status'));
    const masked = issues.filter((i) => i.ruleId === RULE);

    // Line 6: tsc | head && echo "tsc clean";  line 12: eslint | tail && echo "lint OK".
    expect(masked.map((i) => i.line).sort((a, b) => a - b)).toEqual([6, 12]);
    expect(masked[0].severity).toBe('warning');
    expect(masked[0].message).toContain('exit status comes from "head", not "tsc"');
    // Line 18 (no filter), 25 (pipefail in scope), 31 (no claim) stay clean.
  });
});

describe('checkCommands — commands/exit-status-masked in a temp project', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-mask-'));
    resetPackageJsonCache();
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    resetPackageJsonCache();
  });

  async function run(md: string, pkg: Record<string, unknown>) {
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify(pkg));
    fs.writeFileSync(path.join(tmpRoot, 'CLAUDE.md'), md);
    const parsed = parseContextFile({
      absolutePath: path.join(tmpRoot, 'CLAUDE.md'),
      relativePath: 'CLAUDE.md',
      isSymlink: false,
      type: 'context',
    });
    return (await checkCommands(parsed, tmpRoot)).filter((i) => i.ruleId === RULE);
  }

  it('flags the biome `$?` shape that this rule was written for', async () => {
    const issues = await run(
      '```bash\nnpx biome check src/ 2>&1 | tail -5; echo "exit=$?"\n```\n',
      {
        devDependencies: { '@biomejs/biome': '^2.0.0' },
      },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('exit status comes from "tail", not "biome"');
    expect(issues[0].message).toContain('`$?` reports the filter');
  });

  // The `$?` read is often written on its own line right after the pipeline.
  it('flags a `$?` echo on the line after the masked pipeline, in the same fence', async () => {
    const issues = await run('```bash\nnpx tsc --noEmit | head -20\necho "exit=$?"\n```\n', {
      devDependencies: { typescript: '^5' },
    });
    expect(issues.map((i) => i.line)).toEqual([2]);
    expect(issues[0]?.message).toContain('exit status comes from "head", not "tsc"');
  });

  // Controls: the `$?` read must be the NEXT line of the SAME fence, and the
  // line before it must be the masked pipeline itself.
  it('stays silent when the `$?` line is in another fence, not adjacent, or follows no pipeline', async () => {
    const issues = await run(
      '```bash\nnpx tsc --noEmit | head -20\n```\n\n```bash\necho "exit=$?"\n```\n\n' +
        '```bash\nnpx tsc --noEmit | head -20\nls\necho "exit=$?"\n```\n\n' +
        '```bash\nnpx tsc --noEmit\necho "exit=$?"\n```\n',
      { devDependencies: { typescript: '^5' } },
    );
    expect(issues).toEqual([]);
  });

  it('stays silent when pipefail is set earlier in the same fence', async () => {
    const issues = await run(
      '```bash\nset -euo pipefail\nnpx biome check src/ | tail -5 && echo "all clean"\n```\n',
      { devDependencies: { '@biomejs/biome': '^2.0.0' } },
    );
    expect(issues).toEqual([]);
  });
});
