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
