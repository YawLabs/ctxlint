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
    expect(
      findBinInvocations('```bash\ntailscale-mcp --log-level=debug doctor\n```\n', bins).map(
        (i) => i.sub,
      ),
    ).toEqual(['doctor']);
    // Several flags, `=`-valued and conventional booleans, are all skipped.
    expect(
      findBinInvocations(
        '```bash\ntailscale-mcp --log-level=debug -q --no-color --json doctor --fix\n```\n',
        bins,
      ),
    ).toEqual([
      {
        bin: 'tailscale-mcp',
        sub: 'doctor',
        cmd: 'tailscale-mcp --log-level=debug -q --no-color --json doctor --fix',
        line: 2,
      },
    ]);
    expect(findBinInvocations('```bash\ntailscale-mcp --version\n```\n', bins)).toEqual([]);
    expect(findBinInvocations('```bash\ntailscale-mcp --verbose -q\n```\n', bins)).toEqual([]);
  });

  it('does not take a value-less flag argument as the subcommand', () => {
    // `json` is --format's value, not a subcommand; `install` may or may not be.
    expect(findBinInvocations('```bash\ntailscale-mcp --format json install\n```\n', bins)).toEqual(
      [],
    );
    // With the known set available, a known bareword after the flag is accepted.
    const knownFor = () => new Set(['install']);
    expect(
      findBinInvocations('```bash\ntailscale-mcp --verbose install\n```\n', bins, {
        knownFor,
      }).map((i) => i.sub),
    ).toEqual(['install']);
  });

  it('does not read a markdown blockquote as a `>` prompt', () => {
    expect(findBinInvocations('> tailscale-mcp is a small server.\n', bins)).toEqual([]);
    // `$` is still a prompt in prose.
    expect(findBinInvocations('$ tailscale-mcp doctor\n', bins).map((i) => i.sub)).toEqual([
      'doctor',
    ]);
  });

  it('reads only $-prompted lines of a console fence; the rest is output', () => {
    const md = '```console\n$ tailscale-mcp doctor\ntailscale-mcp started on port 3000\n```\n';
    expect(findBinInvocations(md, bins).map((i) => [i.sub, i.line])).toEqual([['doctor', 2]]);
  });

  it('treats an unprompted untagged fence as possible output unless a line resolves', () => {
    const output = '```\ntailscale-mcp started on port 3000\n```\n';
    expect(findBinInvocations(output, bins)).toEqual([]);
    expect(findBinInvocations(output, bins, { knownFor: () => new Set(['deploy-acl']) })).toEqual(
      [],
    );
    // A line naming a KNOWN subcommand proves the block holds commands.
    const commands = '```\ntailscale-mcp deploy-acl\ntailscale-mcp doctor\n```\n';
    expect(
      findBinInvocations(commands, bins, { knownFor: () => new Set(['deploy-acl']) }).map(
        (i) => i.sub,
      ),
    ).toEqual(['deploy-acl', 'doctor']);
    // Prompts settle it without the known set.
    expect(
      findBinInvocations('```\n$ tailscale-mcp doctor\nok\n```\n', bins).map((i) => i.sub),
    ).toEqual(['doctor']);
  });

  it('does not let a `<!--` inside a fence swallow the closing fence', () => {
    const md = '```bash\necho "<!-- not a comment"\n```\n\nRun `tailscale-mcp doctor`.\n';
    expect(findBinInvocations(md, bins).map((i) => [i.sub, i.line])).toEqual([['doctor', 5]]);
  });

  it('still reads prose around a self-contained HTML comment, but not inside it', () => {
    const md = 'Run `tailscale-mcp doctor`. <!-- `tailscale-mcp ghost` -->\n';
    expect(findBinInvocations(md, bins).map((i) => i.sub)).toEqual(['doctor']);
  });

  it('matches `node <bin entry> <sub>` when the path is one of the bins', () => {
    const md = '```bash\nnode dist/index.js doctor --json\nnode other.js doctor\n```\n';
    expect(
      findBinInvocations(md, bins, {
        bins: [{ name: 'tailscale-mcp', entry: './dist/index.js' }],
      }),
    ).toEqual([
      { bin: 'tailscale-mcp', sub: 'doctor', cmd: 'node dist/index.js doctor --json', line: 2 },
    ]);
  });

  it('matches `npx <package>[@version] <sub>` for this package', () => {
    const md =
      '```bash\nnpx @yawlabs/tailscale-mcp@latest doctor\nnpx tailscale-mcp@1.2.3 doctor\nnpx @other/tailscale-mcp doctor\n```\n';
    expect(
      findBinInvocations(md, bins, { packageName: '@yawlabs/tailscale-mcp' }).map((i) => i.line),
    ).toEqual([2, 3]);
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
    // `help` is Commander's implicit help command.
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])].sort()).toEqual(['audit', 'fix', 'help']);
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

  it('bails on a Map/Set dispatch instead of resolving the literal {help}', () => {
    write(
      'cli.js',
      `const COMMANDS = new Map([['serve', serve], ['doctor', doctor]]);
       const sub = process.argv[2];
       if (sub === 'help') usage();
       else if (COMMANDS.has(sub)) COMMANDS.get(sub)();`,
    );
    expect(knownSubcommands(tmp, 'cli.js')).toBeNull();
  });

  it('bails on a method call on the token and on an unguarded hand-off', () => {
    write(
      'a.js',
      `const sub = process.argv[2];\nif (sub === 'x') x();\nif (sub.startsWith('db:')) db();`,
    );
    expect(knownSubcommands(tmp, 'a.js')).toBeNull();
    write(
      'b.js',
      `const sub = process.argv[2];\nif (sub === 'help') usage();\nelse runCommand(sub);`,
    );
    expect(knownSubcommands(tmp, 'b.js')).toBeNull();
  });

  it('ends a switch at its matching brace, not at the first column-0 }', () => {
    write(
      'cli.js',
      `function main() {
  const sub = process.argv[2];
  switch (sub) {
    case 'audit': { return audit(); }
    case 'fix': return fix();
  }
  switch (mode) { case 'not-a-subcommand': return; }
}`,
    );
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])].sort()).toEqual(['audit', 'fix']);
  });

  it('adds Commander aliases and the implicit help command', () => {
    write(
      'cli.js',
      `program.command('audit').alias('a').action(a);
program.command('fix').aliases(['f', 'repair']).action(f);`,
    );
    expect([...(knownSubcommands(tmp, 'cli.js') ?? [])].sort()).toEqual([
      'a',
      'audit',
      'f',
      'fix',
      'help',
      'repair',
    ]);
    write('off.js', `program.command('audit').action(a);\nprogram.helpCommand(false);`);
    expect([...(knownSubcommands(tmp, 'off.js') ?? [])]).toEqual(['audit']);
  });

  it('bails when the Commander program is handed to another function', () => {
    write(
      'cli.js',
      `import { registerAudit } from './audit.js';
program.command('fix').action(f);
registerAudit(program);`,
    );
    expect(knownSubcommands(tmp, 'cli.js')).toBeNull();
    write('add.js', `program.command('fix').action(f);\nprogram.addCommand(makeAudit());`);
    expect(knownSubcommands(tmp, 'add.js')).toBeNull();
  });

  it('refuses a bin entry or shim target outside the project root', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-cli-outside-'));
    try {
      fs.writeFileSync(
        path.join(outside, 'cli.js'),
        `const sub = process.argv[2];\nif (sub === 'serve') serve();`,
      );
      const rel = path.relative(tmp, path.join(outside, 'cli.js'));
      expect(rel.startsWith('..')).toBe(true);
      expect(knownSubcommands(tmp, rel)).toBeNull();
      write(
        'bin/shim.js',
        `#!/usr/bin/env node\nimport '${rel.replace(/\\/g, '/').replace(/^\.\.\//, '../../')}';`,
      );
      expect(knownSubcommands(tmp, 'bin/shim.js')).toBeNull();
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
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

  const CLI = fs.readFileSync(path.join(FIXTURES, 'unknown-subcommand', 'cli.js'), 'utf-8');

  async function runIn(markdown: string, pkg: Record<string, unknown>) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-sub-proh-'));
    try {
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkg));
      fs.writeFileSync(path.join(tmp, 'cli.js'), CLI);
      fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), markdown);
      const parsed = parseContextFile({
        absolutePath: path.join(tmp, 'CLAUDE.md'),
        relativePath: 'CLAUDE.md',
        isSymlink: false,
        type: 'context',
      });
      return (await checkCommands(parsed, tmp)).filter((i) => i.ruleId === RULE);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function runWith(markdown: string) {
    return runIn(markdown, { name: 'x', bin: { 'tailscale-mcp': 'cli.js' } });
  }

  // checkCommands must hand findBinInvocations the package name, the bins and
  // the resolved subcommand sets; without them the evidence-based paths below
  // never run in the real rule.
  describe('scanner options wired through checkCommands', () => {
    it('reads an unprompted untagged fence once a line names a known subcommand', async () => {
      const found = await runWith(
        '# Ops\n\n```\ntailscale-mcp deploy-acl\ntailscale-mcp doctor\n```\n',
      );
      expect(found.map((i) => i.line)).toEqual([5]);
    });

    it('still skips an unprompted untagged fence with no known subcommand (sample output)', async () => {
      expect(await runWith('# Ops\n\n```\ntailscale-mcp started on port\n```\n')).toEqual([]);
    });

    it('does not report sample-output lines in an untagged fence that also holds a command', async () => {
      // The known `deploy-acl` line proves the block holds a command, but the
      // lines after it read as its output, not as more invocations.
      const found = await runWith(
        '# Ops\n\n```\ntailscale-mcp deploy-acl\ntailscale-mcp listening on port 3000\ntailscale-mcp ready: 3 checks ok\n```\n',
      );
      expect(found).toEqual([]);
    });

    it('still reports a near-miss of a known subcommand in such a fence', async () => {
      const found = await runWith(
        '# Ops\n\n```\ntailscale-mcp deploy-acl\ntailscale-mcp deploy-acls production\n```\n',
      );
      expect(found.map((i) => i.line)).toEqual([5]);
    });

    it('does not take the value of --debug as the subcommand', async () => {
      expect(await runWith('# Ops\n\nRun `tailscale-mcp --debug http deploy-acl`.\n')).toEqual([]);
    });

    it('reaches the subcommand after a conventional boolean flag', async () => {
      const found = await runWith('# Ops\n\nRun `tailscale-mcp --verbose doctor`.\n');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"doctor" is not a subcommand of tailscale-mcp');
    });

    it('matches `node <bin entry> <sub>` and `npx <package> <sub>`', async () => {
      const found = await runIn(
        '# Ops\n\n```bash\nnode cli.js doctor\nnpx @acme/ts-ops@latest doctor\n```\n',
        { name: '@acme/ts-ops', bin: { 'tailscale-mcp': 'cli.js' } },
      );
      expect(found.map((i) => i.line)).toEqual([4, 5]);
    });
  });

  // unknown-subcommand runs its own pass over the file, so it did not inherit
  // the prohibition gate the dispatch loop applies. An invocation the doc cites
  // only to forbid is not a broken doc -- "NEVER run `<bin> doctor`" is the doc
  // working correctly.
  describe('prohibition gate', () => {
    it('does NOT flag an unknown subcommand cited under a prohibition', async () => {
      expect(await runWith('# Ops\n\nNEVER run `tailscale-mcp doctor` -- it hangs.\n')).toEqual([]);
    });

    it('still flags the same invocation when mentioned affirmatively', async () => {
      const found = await runWith('# Ops\n\nVerify the build with `tailscale-mcp doctor`.\n');
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain('"doctor" is not a subcommand of tailscale-mcp');
    });

    // The invocation must be located by CODE SPAN identity, not by a substring
    // search: an un-backticked prose mention earlier on the line used to win
    // the indexOf and hand the check the wrong prefix.
    it('uses the backticked occurrence, not an earlier bare prose mention', async () => {
      expect(
        await runWith(
          '# Ops\n\nThe tailscale-mcp doctor check is gone; never run `tailscale-mcp doctor`.\n',
        ),
      ).toEqual([]);
    });

    // ...and a shorter command that is a PREFIX of a longer sibling invocation
    // must not inherit the longer one's prohibition.
    it('does not let a longer prohibited sibling suppress a shorter affirmative one', async () => {
      const found = await runWith(
        '# Ops\n\nNever run `tailscale-mcp doctor --json` in CI; run `tailscale-mcp doctor` locally instead.\n',
      );
      expect(found).toHaveLength(1);
      // The surviving finding is the affirmative one, not the prohibited
      // `--json` sibling.
      expect(found[0].message).toContain('tailscale-mcp doctor');
      expect(found[0].message).not.toContain('--json');
    });

    it('does NOT flag a list under a conditional prohibition lead', async () => {
      expect(
        await runWith('# Ops\n\nNever run these without approval:\n\n- `tailscale-mcp nuke`\n'),
      ).toEqual([]);
    });
  });
});
