import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkCommands } from '../commands.js';
import {
  analyzeMaskedExitStatus,
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

  it('is null for non-verifiers', () => {
    expect(verifierName('git log')).toBeNull();
    expect(verifierName('npm run build', { build: 'esbuild src' })).toBeNull();
  });

  it('recognises filters, including through wrappers', () => {
    expect(filterName('head -20')).toBe('head');
    expect(filterName('tail -n 5')).toBe('tail');
    expect(filterName('node scripts/x.js')).toBeNull();
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

  it('stays silent when pipefail is set earlier in the same fence', async () => {
    const issues = await run(
      '```bash\nset -euo pipefail\nnpx biome check src/ | tail -5 && echo "all clean"\n```\n',
      { devDependencies: { '@biomejs/biome': '^2.0.0' } },
    );
    expect(issues).toEqual([]);
  });
});
