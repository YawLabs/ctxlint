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

  // ---- permissions.deny cross-check: an npx command the user has explicitly
  // DENIED in .claude/settings.json[.local] is one they've told the agent never
  // to run, so the "add to devDependencies" nudge is noise for it. ----

  it('does NOT flag an npx command that matches a permissions.deny entry', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx netlify deploy\n```\n',
        '.claude/settings.json': JSON.stringify({
          permissions: { deny: ['Bash(npx netlify deploy:*)'] },
        }),
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeUndefined();
  });

  // Control: the SAME command with no deny entry is still flagged, proving the
  // deny match -- not some other change -- is what suppressed it above.
  it('DOES flag the same npx command when no deny entry covers it', async () => {
    seed(
      { 'CLAUDE.md': '# Commands\n\n```bash\nnpx netlify deploy\n```\n' },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('netlify');
  });

  // The deny is specific: a DIFFERENT npx command not covered by it is still
  // validated -- the cross-check narrows false positives without blinding npx.
  it('still flags a different npx command not covered by the deny entry', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx some-rare-tool\n```\n',
        '.claude/settings.json': JSON.stringify({
          permissions: { deny: ['Bash(npx netlify deploy:*)'] },
        }),
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('some-rare-tool');
  });

  // A broader deny prefix (`npx netlify:*`) in settings.local.json suppresses a
  // more specific invocation (`npx netlify deploy --prod`).
  it('honors a broader deny prefix from settings.local.json', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx netlify deploy --prod\n```\n',
        '.claude/settings.local.json': JSON.stringify({
          permissions: { deny: ['Bash(npx netlify:*)'] },
        }),
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeUndefined();
  });

  // Word-boundary: a command that only shares a TEXTUAL prefix with a deny
  // matcher (`npx netlifyctl` vs deny `npx netlify`) is NOT over-suppressed.
  it('does NOT over-suppress a command that only shares a textual prefix', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpx netlifyctl\n```\n',
        '.claude/settings.json': JSON.stringify({
          permissions: { deny: ['Bash(npx netlify:*)'] },
        }),
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('netlifyctl');
  });

  // ---- Prose prohibition: a command a doc mentions only to FORBID running
  // ("NEVER run `npx netlify deploy` directly.") must not demand the dep be
  // installed -- even when no permissions.deny entry backs the prohibition.

  it('does NOT flag an npx command mentioned under NEVER-run prohibition (no deny entry)', async () => {
    // Verbatim from a real CLAUDE.md that misfired. No settings files seeded:
    // the suppression must come from the prose negation alone.
    seed(
      {
        'CLAUDE.md':
          '# Release & Deploy Rules\n\n' +
          '- **NEVER run `npx netlify deploy` directly.** Always use ' +
          '`cd ~/yaw/yaw_terminal/yaw.sh && ./deploy.sh` (that repo carries `netlify-cli` as ' +
          'a devDependency; this one does not). The deploy script downloads missing ' +
          'cross-platform binaries from the GitHub release before deploying.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeUndefined();
  });

  it('does NOT flag npx commands under "Do not run" / "don\'t use" prohibitions', async () => {
    seed(
      {
        'CLAUDE.md':
          '# Rules\n\n' +
          '- Do not run `npx some-cli deploy` from this repo.\n' +
          "- Please don't use `npx other-cli` here; the wrapper script handles it.\n",
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.filter((i) => i.ruleId === 'commands/npx-not-in-deps')).toEqual([]);
  });

  // Control: an AFFIRMATIVE mention of the same command still flags, proving
  // the negation context -- not some broader change -- is what suppressed it.
  it('still flags the same npx command when mentioned affirmatively', async () => {
    seed(
      {
        'CLAUDE.md': '# Deploy\n\nUse `npx netlify deploy` to ship the site.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('netlify');
  });

  // Control: negation in a PREVIOUS sentence does not govern the command --
  // the same-sentence boundary keeps the suppression from leaking.
  it('still flags when the negation is in a previous sentence', async () => {
    seed(
      {
        'CLAUDE.md': '# Deploy\n\nNever commit secrets. Deploy with `npx netlify deploy`.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  // ---- Prohibition-scope tightening: four over-suppression shapes were
  // empirically confirmed (each probed to 0 flags while the doc MANDATED the
  // command, i.e. a genuine missing dep went unreported). Shapes 1-3 must
  // flag; shape 4 is pinned as a deliberately accepted false negative. ----

  // Shape 1a: "Instead of <bad way>, run `npx x`" RECOMMENDS the command --
  // comparative framings were dropped from the prohibition token set.
  it('flags a command recommended via "Instead of ..., run `npx x`"', async () => {
    seed(
      {
        'CLAUDE.md':
          '# Deploy\n\nInstead of clicking around the Netlify UI, run `npx netlify deploy`.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('netlify');
  });

  // Shape 1b: same for "Rather than ..." framing.
  it('flags a command recommended via "Rather than ..., use `npx x`"', async () => {
    seed(
      {
        'CLAUDE.md': '# Deploy\n\nRather than the dashboard, use `npx netlify deploy` to ship.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  // Shape 2: a negation-looking token INSIDE an earlier code span
  // (`avoid-cycles`) is code, not prose -- spans are masked before the
  // negation search, so the later npx mention still flags.
  it('does NOT let `avoid-cycles` in an earlier code span suppress a later npx mention', async () => {
    seed(
      {
        'CLAUDE.md':
          '# Imports\n\nThe `avoid-cycles` rule requires `npx dep-graph-tool` to verify imports.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    const byRule = issues.find((i) => i.ruleId === 'commands/npx-not-in-deps');
    expect(byRule).toBeDefined();
    expect(byRule!.message).toContain('dep-graph-tool');
  });

  // Shape 3a: a spaced ` -- ` ends the prohibition clause -- the command
  // after it is the recommended half of the line.
  it('flags the command after "NEVER guess -- run `npx x`" (spaced -- ends the clause)', async () => {
    seed(
      {
        'CLAUDE.md': '# Deploy\n\nNEVER guess about deploy state -- run `npx netlify status` to check.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  // Shape 3b: a semicolon ends the prohibition clause.
  it('flags the command after "Never use the UI; deploy with `npx x`" (semicolon ends the clause)', async () => {
    seed(
      {
        'CLAUDE.md': '# Deploy\n\nNever use the web UI; deploy with `npx netlify deploy`.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  // Shape 3c: an em-dash ends the prohibition clause, same as ` -- `.
  it('flags the command after an em-dash clause boundary', async () => {
    seed(
      {
        'CLAUDE.md': '# Deploy\n\nNEVER guess about deploy state — run `npx netlify status` to check.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  // Control for 3a: a double-hyphen WITHOUT surrounding whitespace is a CLI
  // flag, not a clause boundary -- the prohibition still reaches the command.
  it('does not treat an unspaced --flag as a clause boundary', async () => {
    seed(
      {
        'CLAUDE.md': '# Deploy\n\nNEVER pass --prod when testing `npx netlify deploy` locally.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeUndefined();
  });

  // Shape 4: known ACCEPTED false negative, pinned deliberately. "Don't
  // forget to run `npx x`" suppresses even though the command is recommended:
  // the negation binds to "forget", not the command, and telling those apart
  // needs verb analysis this check deliberately avoids -- the module's
  // documented posture is false-negative-over-false-positive for this
  // warning-severity nudge. If this test starts failing because the mention
  // now FLAGS, that's a posture change to make consciously, not a bug fix.
  it('accepted false negative: "Don\'t forget to run `npx x`" stays suppressed', async () => {
    seed(
      {
        'CLAUDE.md': "# Release\n\nDon't forget to run `npx changeset-tool` before releasing.\n",
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeUndefined();
  });

  // Shape 5: the comma. English separates "don't do X" from "do Y" with a
  // comma far more often than with a semicolon, and treating the comma as
  // inert let the leading negation govern the RECOMMENDED command. The
  // semicolon form of this exact sentence was already flagged, so the two
  // differed only by punctuation.
  it('flags a command recommended after a contrast comma ("Don\'t X, run `npx y`")', async () => {
    seed(
      {
        'CLAUDE.md': "# Build\n\nDon't edit dist by hand, run `npx some-rare-tool` instead.\n",
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  // The counterweight: a comma is equally how a prohibition LIST is written,
  // so the comma must not become an unconditional clause boundary.
  it('keeps suppressing every item of a comma-separated prohibition list', async () => {
    seed(
      {
        'CLAUDE.md':
          '# Deploy\n\nNEVER run `npx pkg-alpha`, `npx pkg-beta`, or `npx pkg-gamma` here.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.filter((i) => i.ruleId === 'commands/npx-not-in-deps')).toHaveLength(0);
  });

  // Narrowing at the comma is not the same as un-suppressing: the narrowed
  // tail is still tested, so a second negation in it still governs.
  it('stays suppressed when the post-comma clause carries its own negation', async () => {
    seed(
      {
        'CLAUDE.md': '# Secrets\n\nNever commit secrets, and never run `npx leak-tool` here.\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeUndefined();
  });

  // The prohibition gate used to guard only npx-not-in-deps. Every sibling
  // rule reports the same "does not resolve" class and must honor it too.
  it('does NOT flag a prohibited common tool (tool-not-found honors the gate)', async () => {
    seed(
      { 'CLAUDE.md': '# Rules\n\nNEVER run `tsc --noEmit` here. Use the build script.\n' },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/tool-not-found')).toBeUndefined();
  });

  it('does NOT flag a prohibited npm script (script-not-found honors the gate)', async () => {
    seed({ 'CLAUDE.md': '# Rules\n\nNEVER run `npm run deploy` by hand.\n' }, { scripts: {} });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/script-not-found')).toBeUndefined();
  });

  it('does NOT flag a prohibited make target (no-makefile honors the gate)', async () => {
    seed({ 'CLAUDE.md': '# Rules\n\nNEVER run `make deploy` locally.\n' }, { scripts: {} });
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/no-makefile')).toBeUndefined();
  });

  // Control for the three above: without the prohibition the same references
  // still fire, so the gate is what suppressed them and not a broken branch.
  it('still flags the same references when mentioned affirmatively', async () => {
    seed(
      {
        'CLAUDE.md':
          '# Rules\n\nRun `tsc --noEmit` before committing.\n\nRun `npm run deploy` to ship.\n\nRun `make deploy` locally.\n',
      },
      { scripts: {}, dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/tool-not-found')).toBeDefined();
    expect(issues.find((i) => i.ruleId === 'commands/script-not-found')).toBeDefined();
    expect(issues.find((i) => i.ruleId === 'commands/no-makefile')).toBeDefined();
  });

  // A deny entry now silences the newly-gated rules too, not just the npx one
  // it was originally written for. That is an error/warning-severity behavior
  // change and it is the half of the gate least likely to be noticed if it
  // regresses, since every other deny test is an npx test.
  it('honors a permissions.deny entry for tool-not-found, not just npx', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\ntsc --noEmit\n```\n',
        '.claude/settings.json': JSON.stringify({ permissions: { deny: ['Bash(tsc:*)'] } }),
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/tool-not-found')).toBeUndefined();
  });

  it('honors a permissions.deny entry for script-not-found', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nnpm run deploy\n```\n',
        '.claude/settings.json': JSON.stringify({
          permissions: { deny: ['Bash(npm run deploy:*)'] },
        }),
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/script-not-found')).toBeUndefined();
  });

  // A command written inside an HTML comment is commentary ABOUT a command,
  // not one to run. The parser has no comment handling, so a commented-out
  // note was linted as if it were live documentation.
  it('does NOT flag a command that sits inside an HTML comment', async () => {
    seed(
      {
        'CLAUDE.md':
          '# Notes\n\n<!-- TODO: we used to run `npx some-rare-tool` here, removed in v2 -->\n',
      },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.filter((i) => i.check === 'commands')).toHaveLength(0);
  });

  // The mirror image: a prohibition INSIDE a comment is commentary too, and
  // must not govern a live command sitting outside it on the same line.
  it('does not let a negation inside an HTML comment suppress a live command', async () => {
    seed(
      { 'CLAUDE.md': '# Notes\n\n<!-- never --> run `npx some-rare-tool` to build.\n' },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  // package-json-missing is an info about work that was SKIPPED. A command the
  // doc only forbids would not have been validated even with a package.json,
  // so it must not be the reference that triggers the notice.
  it('does NOT emit the missing-package.json info when the only command is prohibited', async () => {
    seed({ 'CLAUDE.md': '# Release\n\nNEVER run `npx some-rare-tool` here.\n' }, null);
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/package-json-missing')).toBeUndefined();
  });

  // ---- Accepted limits of the contrast-comma heuristic, pinned deliberately.
  // Each is a documented false negative/positive in the module's stated
  // false-negative-preferred posture; closing any needs verb/coordination
  // analysis this check avoids. If one of these starts behaving differently,
  // that is a posture change to make consciously, not a bug fix. ----

  it('accepted limit: only the LAST comma is considered, so a post-contrast list is split', async () => {
    seed(
      { 'CLAUDE.md': "# Build\n\nDon't edit dist, run `npx pkg-alpha`, `npx pkg-beta`.\n" },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const messages = (await checkCommands(parsed, tmpRoot))
      .filter((i) => i.ruleId === 'commands/npx-not-in-deps')
      .map((i) => i.message)
      .join(' ');
    // pkg-alpha un-suppresses (a verb follows its comma); pkg-beta does not.
    expect(messages).toContain('pkg-alpha');
    expect(messages).not.toContain('pkg-beta');
  });

  it('accepted limit: a coordinated continuation with a recommendation verb un-suppresses', async () => {
    seed(
      { 'CLAUDE.md': '# Build\n\nNever install it globally, or run `npx pkg-gamma` here.\n' },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  it('accepted limit: a `.` inside a version truncates the clause and drops the prohibition', async () => {
    seed(
      { 'CLAUDE.md': '# Build\n\nNever run the v1.2 tool `npx pkg-delta` here.\n' },
      { dependencies: {}, devDependencies: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/npx-not-in-deps')).toBeDefined();
  });

  // exit-status-masked is deliberately OUTSIDE the gate: it reports the
  // command's SHAPE, which is worth flagging even in a forbidden example.
  it('still reports exit-status-masked on a prohibited command', async () => {
    seed(
      {
        'CLAUDE.md':
          '# Rules\n\nNEVER run `npm test | tail -1 && echo ok` -- it hides failures.\n',
      },
      { scripts: { test: 'vitest' } },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/exit-status-masked')).toBeDefined();
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
  // `bun test` runs Bun's builtin test runner — no `test` script required, so
  // it must never produce commands/script-not-found, even when package.json
  // has no `test` script. (`npm/pnpm/yarn test` DO resolve to a script and
  // stay validated — covered by the it.each below.)
  it('does NOT flag `bun test` as a missing script (builtin test runner)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nbun test\n```\n',
      },
      { scripts: {} },
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/script-not-found')).toBeUndefined();
  });

  it('does NOT emit package-json-missing for a `bun test`-only file (builtin)', async () => {
    seed(
      {
        'CLAUDE.md': '# Commands\n\n```bash\nbun test\n```\n',
      },
      null, // no package.json — `bun test` would never be validated anyway
    );
    const parsed = parseContextFile(discoveredIn('CLAUDE.md'));
    const issues = await checkCommands(parsed, tmpRoot);
    expect(issues.find((i) => i.ruleId === 'commands/package-json-missing')).toBeUndefined();
  });

  it.each([
    { cmd: 'yarn test', script: 'test' },
    { cmd: 'pnpm test', script: 'test' },
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
