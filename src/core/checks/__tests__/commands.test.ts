import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkCommands } from '../commands.js';
import { resetPackageJsonCache } from '../../../utils/fs.js';
import type { DiscoveredFile } from '../../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');

function makeDiscovered(fixtureName: string, fileName: string): DiscoveredFile {
  return {
    absolutePath: path.join(FIXTURES, fixtureName, fileName),
    relativePath: fileName,
    isSymlink: false,
    type: 'context',
  };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-cmd-'));
  resetPackageJsonCache();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  resetPackageJsonCache();
});

function seed(
  files: Record<string, string>,
  pkg: Record<string, unknown> | null = { scripts: {} },
): void {
  if (pkg) {
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify(pkg));
  }
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(tmpRoot, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

function discoveredIn(fileName: string): DiscoveredFile {
  return {
    absolutePath: path.join(tmpRoot, fileName),
    relativePath: fileName,
    isSymlink: false,
    type: 'context',
  };
}

describe('checkCommands', () => {
  it('reports missing npm scripts', async () => {
    const parsed = parseContextFile(makeDiscovered('wrong-commands', 'AGENTS.md'));
    const projectRoot = path.join(FIXTURES, 'wrong-commands');
    const issues = await checkCommands(parsed, projectRoot);

    const messages = issues.map((i) => i.message);
    // "pnpm test" — script "test" not in package.json
    expect(messages.some((m) => m.includes('"test"') && m.includes('not found'))).toBe(true);
  });

  it('reports missing deploy script', async () => {
    const parsed = parseContextFile(makeDiscovered('wrong-commands', 'AGENTS.md'));
    const projectRoot = path.join(FIXTURES, 'wrong-commands');
    const issues = await checkCommands(parsed, projectRoot);

    const messages = issues.map((i) => i.message);
    expect(messages.some((m) => m.includes('"deploy"'))).toBe(true);
  });

  it('reports no issues for healthy project', async () => {
    const parsed = parseContextFile(makeDiscovered('healthy-project', 'CLAUDE.md'));
    const projectRoot = path.join(FIXTURES, 'healthy-project');
    const issues = await checkCommands(parsed, projectRoot);
    expect(issues.length).toBe(0);
  });

  it('flags make target missing from Makefile (make-target-not-found)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nmake build\n```\n',
        Makefile: 'test:\n\techo test\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/make-target-not-found');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('build');
  });

  it('flags make command when no Makefile exists (no-makefile)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nmake test\n```\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/no-makefile');
    expect(byRule).toBeDefined();
  });

  it('flags npx package not in deps and not in node_modules/.bin', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx some-rare-tool\n```\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('some-rare-tool');
  });

  it('flags the actual package after `npx -y` (skips the -y flag)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx -y @yawlabs/typo\n```\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('@yawlabs/typo');
  });

  it('honors `-p <pkg>` as the package override', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx -p @yawlabs/missing some-bin\n```\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('@yawlabs/missing');
  });

  it('honors `--package=<pkg>` as the package override', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx --package=@yawlabs/missing some-bin\n```\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('@yawlabs/missing');
  });

  it('does NOT flag npx when the package has a bin in node_modules/.bin', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'node_modules', '.bin', 'present-tool'), '');
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx present-tool\n```\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeUndefined();
  });

  it('flags common tool missing from deps (tool-not-found)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nvitest run\n```\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/tool-not-found');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('vitest');
  });

  // The `tsc` bin ships in the `typescript` package; the tool branch must
  // consult the bin->package map before the deps lookup so a fresh checkout
  // (no node_modules) with typescript in devDependencies stays clean.
  it('does NOT flag `tsc` when typescript is in devDependencies (bin->package map)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\nRun `tsc --noEmit` before committing.\n',
      },
      { devDependencies: { typescript: '^5' } },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/tool-not-found')).toBeUndefined();
  });

  it('still flags `tsc` when typescript is absent from deps and node_modules/.bin', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\ntsc --noEmit\n```\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/tool-not-found');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('tsc');
  });

  // >-quoted prose inside a bare fence must not surface as a make command —
  // with no Makefile in the project it would otherwise be a false
  // commands/no-makefile error.
  it('does not flag >-quoted prose in a bare fence as a make command', async () => {
    seed(
      {
        'CLAUDE.md': '# PR template\n\n```\n> make sure tests pass before merging\n```\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/no-makefile')).toBeUndefined();
    expect(issues.find((i) => i.ruleId === 'commands/make-target-not-found')).toBeUndefined();
  });

  it('does NOT flag common tool present in devDependencies', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nvitest run\n```\n',
      },
      { devDependencies: { vitest: '^4' } },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/tool-not-found')).toBeUndefined();
  });

  it('does NOT flag common tool when a bin symlink exists in node_modules/.bin', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'node_modules', '.bin', 'eslint'), '');
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\neslint .\n```\n',
      },
      { dependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/tool-not-found')).toBeUndefined();
  });

  it('emits a single info when package.json is missing but a command would be checked', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpm run build\nvitest run\n```\n',
      },
      null, // no package.json written
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const skipped = issues.filter((i) => i.ruleId === 'commands/package-json-missing');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].severity).toBe('info');
    expect(skipped[0].message).toContain('command checks skipped');
    // The script/tool branches themselves must stay silent without a pkgJson.
    expect(issues.find((i) => i.ruleId === 'commands/script-not-found')).toBeUndefined();
    expect(issues.find((i) => i.ruleId === 'commands/tool-not-found')).toBeUndefined();
  });

  it('does NOT emit the missing-package.json info when only a make target is referenced', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nmake build\n```\n',
        Makefile: 'build:\n\techo build\n',
      },
      null, // no package.json; make branch is independent of pkgJson
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/package-json-missing')).toBeUndefined();
  });

  it('flags shorthand package manager test/build/etc. when script missing', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\npnpm test\n```\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/script-not-found');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('test');
  });

  // Package-manager builtins invoked without `run` (`pnpm install`,
  // `yarn add zod`, ...) are not script names and must never produce
  // commands/script-not-found, no matter what package.json's scripts say.
  it.each(['pnpm install', 'yarn add zod', 'bun install', 'pnpm dlx foo', 'pnpm exec tsc'])(
    'does NOT flag the builtin subcommand in "%s" as a missing script',
    async (cmd) => {
      seed(
        {
          'CLAUDE.md': `# Commands\n\n\`\`\`bash\n${cmd}\n\`\`\`\n`,
        },
        { scripts: { build: 'tsc' } },
      );
      const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
      const issues = await checkCommands(parsed, tmpRoot);
      expect(issues.find((i) => i.ruleId === 'commands/script-not-found')).toBeUndefined();
    },
  );

  it('still validates an explicit `pnpm run <name>` even when <name> collides with a builtin', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\npnpm run install\n```\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/script-not-found');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('"install"');
  });

  it('skips script validation when a flag precedes the name (pnpm -r build)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\npnpm -r build\n```\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/script-not-found')).toBeUndefined();
  });

  it('does NOT emit package-json-missing for a builtin-only command (pnpm install)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\npnpm install\n```\n',
      },
      null, // no package.json — but `pnpm install` would never be validated anyway
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/package-json-missing')).toBeUndefined();
  });

  it('flags a target that only exists as a := variable assignment', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nmake build\n```\n',
        Makefile: 'build := dist\n\ntest:\n\techo test\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/make-target-not-found');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('"build"');
  });

  it('does not treat a make flag as the target (make -j4 build)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nmake -j4 build\n```\n',
        Makefile: 'build:\n\techo b\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    // A leading flag bails out of target extraction entirely — the token
    // after it may be a flag value, not a target.
    expect(issues.find((i) => i.ruleId === 'commands/make-target-not-found')).toBeUndefined();
  });

  it('skips NAME=value overrides when extracting the make target', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nmake FOO=1 missing\n```\n',
        Makefile: 'build:\n\techo b\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/make-target-not-found');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('"missing"');
  });

  // Cover the full set of shorthand package managers (the regex matches
  // npm|pnpm|yarn|bun followed by test|start|build|dev|lint|…) so a future
  // edit to the pattern can't silently drop one.
  it.each([
    { cmd: 'yarn test', script: 'test' },
    { cmd: 'bun test', script: 'test' },
    { cmd: 'yarn build', script: 'build' },
    { cmd: 'bun start', script: 'start' },
    { cmd: 'bun run dev', script: 'dev' },
    { cmd: 'yarn run lint', script: 'lint' },
  ])('flags $cmd when $script is missing from package.json', async ({ cmd, script }) => {
    seed(
      {
        'CLAUDE.md': `# Commands\n\n\`\`\`bash\n${cmd}\n\`\`\`\n`,
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/script-not-found');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain(script);
  });
});
