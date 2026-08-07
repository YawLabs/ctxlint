import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseContextFile } from '../../parser.js';
import { checkCommands } from '../commands.js';
import {
  commandNameOf,
  findBinInvocations,
  knownSubcommands,
  ownedBins,
} from '../cli-subcommands.js';
import { resetPackageJsonCache } from '../../../utils/fs.js';
import type { DiscoveredFile } from '../../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../../fixtures');
const RULE = 'commands/unknown-subcommand';

describe('ownedBins', () => {
  it('reads the object form', () => {
    expect(ownedBins({ bin: { 'tailscale-mcp': 'cli.js' } })).toEqual([
      { name: 'tailscale-mcp', entry: 'cli.js' },
    ]);
  });

  it('reads the string form, unscoping the package name', () => {
    expect(ownedBins({ name: '@yawlabs/ctxlint', bin: './cli.js' })).toEqual([
      { name: 'ctxlint', entry: './cli.js' },
    ]);
  });

  it('is empty with no bin field', () => {
    expect(ownedBins({ name: 'x' })).toEqual([]);
    expect(ownedBins(null)).toEqual([]);
  });
});

describe('commandNameOf', () => {
  it('strips paths, quotes and executable extensions', () => {
    expect(commandNameOf('./bin/tailscale-mcp')).toBe('tailscale-mcp');
    expect(commandNameOf('"C:\\build\\postgres-mcp.exe"')).toBe('postgres-mcp');
    expect(commandNameOf('dist/cli.js')).toBe('cli');
  });
});

describe('findBinInvocations', () => {
  const bins = new Set(['tailscale-mcp']);

  it('finds a path-form invocation inside a shell fence', () => {
    const md = '```bash\n./bin/tailscale-mcp doctor --json\n```\n';
    expect(findBinInvocations(md, bins)).toEqual([
      { bin: 'tailscale-mcp', sub: 'doctor', cmd: './bin/tailscale-mcp doctor --json', line: 2 },
    ]);
  });

  it('finds a bare on-PATH invocation and unwraps npx', () => {
    const md = '```bash\nnpx -y tailscale-mcp doctor\n```\n';
    expect(findBinInvocations(md, bins).map((i) => i.sub)).toEqual(['doctor']);
  });

  it('skips flags to reach the subcommand, and ignores flag-only invocations', () => {
    expect(findBinInvocations('```bash\ntailscale-mcp --version\n```\n', bins)).toEqual([]);
  });

  it('ignores a positional path argument (not a subcommand)', () => {
    expect(findBinInvocations('```bash\ntailscale-mcp ./acl.json\n```\n', bins)).toEqual([]);
  });

  it('does not read HTML comments, which discuss commands rather than run them', () => {
    const md = '<!--\n  `tailscale-mcp doctor` is not implemented.\n-->\n';
    expect(findBinInvocations(md, bins)).toEqual([]);
  });

  it('does not read non-shell fences', () => {
    expect(findBinInvocations('```json\ntailscale-mcp doctor\n```\n', bins)).toEqual([]);
  });

  it('finds inline-backtick invocations outside fences', () => {
    expect(
      findBinInvocations('Run `tailscale-mcp doctor` to check.\n', bins).map((i) => i.sub),
    ).toEqual(['doctor']);
  });
});

describe('knownSubcommands', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-cli-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  function write(name: string, src: string): void {
    const full = path.join(tmp, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, src);
  }

  it('reads a closed hand-rolled argv dispatch', () => {
    write(
      'cli.js',
      `const sub = process.argv[2];
       if (sub === "deploy-acl" || sub === "validate-acl") run(sub);
       else if (sub === "version") print();
       else if (sub !== undefined) console.error("unknown");`,
    );
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])].sort()).toEqual([
      'deploy-acl',
      'validate-acl',
      'version',
    ]);
  });

  it('reads a switch dispatch', () => {
    write(
      'cli.js',
      `const sub = process.argv[2];
       switch (sub) {
         case 'audit': return audit();
         case 'fix': return fix();
       }`,
    );
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])].sort()).toEqual(['audit', 'fix']);
  });

  it('reads a literal-array includes', () => {
    write('cli.js', `const sub = process.argv[2];\nif (['a','b'].includes(sub)) go(sub);`);
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('reads Commander .command() names', () => {
    write(
      'cli.js',
      `program.command('audit <path>').action(a);\nprogram.command('fix').action(f);`,
    );
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])].sort()).toEqual(['audit', 'fix']);
  });

  // --- bail-outs: each must be null, i.e. "emit nothing" ---

  it('bails when argv[2] indexes a lookup table', () => {
    write(
      'cli.js',
      `const sub = process.argv[2];\nconst h = HANDLERS[sub];\nif (sub === 'x') y();`,
    );
    expect(knownSubcommands(tmp, 'cli.js')).toBeNull();
  });

  it('bails when argv[2] is compared against a variable', () => {
    write('cli.js', `const sub = process.argv[2];\nif (sub === DEFAULT_CMD) go();`);
    expect(knownSubcommands(tmp, 'cli.js')).toBeNull();
  });

  it('bails when membership is tested against a non-literal', () => {
    write('cli.js', `const sub = process.argv[2];\nif (KNOWN.includes(sub)) go(sub);`);
    expect(knownSubcommands(tmp, 'cli.js')).toBeNull();
  });

  it('bails on Object.keys-driven dispatch', () => {
    write('cli.js', `const sub = process.argv[2];\nif (Object.keys(CMDS).indexOf(sub) >= 0) go();`);
    expect(knownSubcommands(tmp, 'cli.js')).toBeNull();
  });

  it('bails when Commander names are computed', () => {
    write('cli.js', `for (const n of names) program.command(n).action(run);`);
    expect(knownSubcommands(tmp, 'cli.js')).toBeNull();
  });

  it('bails on a bundled/minified entry, which is how ctxlint avoids linting itself wrong', () => {
    write('dist/index.js', `var a=1;${'x'.repeat(600)}\nif(process.argv[2]==="audit"){}`);
    expect(knownSubcommands(tmp, 'dist/index.js')).toBeNull();
  });

  it('bails when there is no dispatcher at all', () => {
    write('cli.js', `import { main } from './lib.js';\nmain();\nexport const x = 1;\nlog();`);
    expect(knownSubcommands(tmp, 'cli.js')).toBeNull();
  });

  it('bails when the entry does not exist', () => {
    expect(knownSubcommands(tmp, 'nope.js')).toBeNull();
  });

  it('ignores prose in comments that reads as an openness signal', () => {
    // Regression: the fixture's own comment says "an unknown subcommand in the
    // docs reads as a hang". A raw scan reads that `in` as the `in` operator
    // and bails on a dispatch that is perfectly closed.
    write(
      'cli.js',
      `// why an unknown subcommand in the docs reads as a hang
       /* HANDLERS[subcommand] would be open; this is not */
       const subcommand = process.argv[2];
       if (subcommand === "serve") serve();`,
    );
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])]).toEqual(['serve']);
  });

  it('ignores openness-shaped text inside string literals', () => {
    write(
      'cli.js',
      `const sub = process.argv[2];
       if (sub === "serve") serve();
       else console.error("usage: sub in [a|b]; KNOWN.includes(sub)");`,
    );
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])]).toEqual(['serve']);
  });

  it('follows a thin bin shim one hop to the real entry', () => {
    write('bin/cli.js', `#!/usr/bin/env node\nimport '../src/main.js';`);
    write('src/main.js', `const sub = process.argv[2];\nif (sub === 'serve') serve();`);
    expect([...(knownSubcommands(tmp, 'bin/cli.js') ?? [])]).toEqual(['serve']);
  });
});

describe('checkCommands — commands/unknown-subcommand', () => {
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

  it('flags `doctor` on the fixture and leaves --version / validate-acl alone', async () => {
    const parsed = parseContextFile(discovered('unknown-subcommand', 'CLAUDE.md'));
    const issues = await checkCommands(parsed, path.join(FIXTURES, 'unknown-subcommand'));
    const found = issues.filter((i) => i.ruleId === RULE);

    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('error');
    expect(found[0].line).toBe(7);
    expect(found[0].message).toContain('"doctor" is not a subcommand of tailscale-mcp');
    expect(found[0].message).toContain('deploy-acl, validate-acl');
  });

  it('emits nothing for a project whose bin entry is unreadable', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-sub-'));
    try {
      fs.writeFileSync(
        path.join(tmp, 'package.json'),
        JSON.stringify({ name: 'x', bin: { widget: 'dist/index.js' } }),
      );
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '```bash\nwidget doctor\n```\n');
      const parsed = parseContextFile({
        absolutePath: path.join(tmp, 'CLAUDE.md'),
        relativePath: 'CLAUDE.md',
        isSymlink: false,
        type: 'context',
      });
      const issues = await checkCommands(parsed, tmp);
      expect(issues.filter((i) => i.ruleId === RULE)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
