import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { encodeProjectDir } from '../../../session-parser.js';
import { clearTranscriptCache } from '../../../transcript.js';
import { checkMissingSecret } from '../missing-secret.js';
import type { SessionContext, HistoryEntry, SiblingRepo } from '../../../types.js';

// The check also reads the current project's transcripts. Point every home
// variable at an empty temp dir so no case can read a real ~/.claude corpus.
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'] as const;
let savedEnv: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'ctxlint-secret-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  clearTranscriptCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  clearTranscriptCache();
  rmSync(home, { recursive: true, force: true });
});

function makeEntry(display: string, project: string, timestamp = 1): HistoryEntry {
  return { display, timestamp, project, sessionId: 'test', provider: 'claude-code' };
}

function makeSibling(name: string, basePath = '/repos'): SiblingRepo {
  return { path: `${basePath}/${name}`, name };
}

function makeCtx(
  history: HistoryEntry[],
  siblings: SiblingRepo[],
  currentProject = '/repos/current',
): SessionContext {
  return { history, memories: [], siblings, currentProject, providers: ['claude-code'] };
}

describe('checkMissingSecret', () => {
  it('returns no issues when history has no gh secret set commands', async () => {
    const ctx = makeCtx(
      [makeEntry('npm test', '/repos/foo'), makeEntry('git push', '/repos/bar')],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues when only one sibling has the secret', async () => {
    const ctx = makeCtx(
      [makeEntry('gh secret set NPM_TOKEN -b xxx', '/repos/foo')],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(0);
  });

  it('flags secret missing from current project when 2+ siblings have it', async () => {
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN -b xxx', '/repos/foo'),
        makeEntry('gh secret set NPM_TOKEN -b yyy', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('session-missing-secret');
    expect(issues[0].message).toContain('NPM_TOKEN');
    // Warning, not error: the evidence is only what was typed, and a secret
    // set in the web UI or at org level is invisible to it.
    expect(issues[0].severity).toBe('warning');
  });

  it('does not flag when current project already has the secret', async () => {
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN -b xxx', '/repos/current'),
        makeEntry('gh secret set NPM_TOKEN -b yyy', '/repos/foo'),
        makeEntry('gh secret set NPM_TOKEN -b zzz', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(0);
  });

  it('returns no issues with empty history', async () => {
    const ctx = makeCtx([], [makeSibling('foo')]);
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(0);
  });

  it('parses gh secret set with --repo flag', async () => {
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN --repo org/foo -b xxx', '/repos/foo'),
        makeEntry('gh secret set NPM_TOKEN --repo org/bar -b yyy', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
  });

  it('captures --repo when the body flag precedes it (body-before-repo ordering)', async () => {
    // `-b "val"` comes BEFORE `--repo` here. The repo binding must still be
    // captured (siblings are matched via the --repo basename, not the history
    // project path, which here is unrelated to the sibling dirs).
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN -b "val" --repo org/foo', '/unrelated/x'),
        makeEntry('gh secret set NPM_TOKEN -b "val" --repo org/bar', '/unrelated/y'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
    expect(issues[0].message).toContain('foo');
    expect(issues[0].message).toContain('bar');
  });

  it('extracts the secret NAME from a flag-first ordering', async () => {
    // `--repo org/foo` precedes NAME. The first token after `set` is `--repo`
    // (a value-taking flag); its value `org/foo` must be skipped so NAME is
    // captured, not `--repo`. Two siblings set it, current is unrelated.
    const ctx = makeCtx(
      [
        makeEntry('gh secret set --repo org/foo NPM_TOKEN -b x', '/unrelated/x'),
        makeEntry('gh secret set --repo org/bar NPM_TOKEN -b y', '/unrelated/y'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
    // The captured name is NPM_TOKEN, not the flag value.
    expect(issues[0].message).not.toContain('--repo');
    expect(issues[0].message).not.toContain('org/foo');
  });

  it('skips the value of -e/--env when hunting for the NAME', async () => {
    // `-e prod` precedes NAME. `-e` is a value-taking flag, so `prod` must be
    // skipped and NPM_TOKEN captured as the name (not `prod`).
    const ctx = makeCtx(
      [
        makeEntry('gh secret set -e prod NPM_TOKEN -b x', '/repos/foo'),
        makeEntry('gh secret set -e prod NPM_TOKEN -b y', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
    expect(issues[0].message).not.toContain('prod');
  });

  it('does not consume the NAME after the boolean -u flag', async () => {
    // `-u`/`--user` is a BOOLEAN flag — it takes no value, so NPM_TOKEN
    // immediately after `-u` is the real NAME and must not be eaten.
    const ctx = makeCtx(
      [
        makeEntry('gh secret set -u NPM_TOKEN -b x', '/repos/foo'),
        makeEntry('gh secret set -u NPM_TOKEN -b y', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
  });

  it('binds repo from the short -R flag (space-separated)', async () => {
    // `-R org/foo` must bind the repo just like `--repo org/foo`. Siblings are
    // matched via the -R basename (history project paths are unrelated here).
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN -R org/foo -b x', '/unrelated/x'),
        makeEntry('gh secret set NPM_TOKEN -R org/bar -b y', '/unrelated/y'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('foo');
    expect(issues[0].message).toContain('bar');
  });

  it('binds repo from --repo=value (equals-separated)', async () => {
    // `--repo=org/foo` must bind the repo just like `--repo org/foo`.
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN --repo=org/foo', '/unrelated/x'),
        makeEntry('gh secret set NPM_TOKEN --repo=org/bar', '/unrelated/y'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('foo');
    expect(issues[0].message).toContain('bar');
  });

  it('does not collide same-basename repos across different orgs', async () => {
    // Two distinct orgs each set NPM_TOKEN on a repo literally named `ci`.
    // Basename-only matching would treat both --repo values as the SAME repo
    // and double-count one sibling. Owner-qualified matching keeps them
    // distinct: orgA/ci binds only to the orgA sibling, orgB/ci only to orgB.
    const orgACi: SiblingRepo = { path: '/repos/orgA-ci', name: 'orgA-ci', gitOrg: 'orgA' };
    const orgBCi: SiblingRepo = { path: '/repos/orgB-ci', name: 'orgB-ci', gitOrg: 'orgB' };
    // Sibling dir basenames differ from the repo name `ci`, so the only way a
    // --repo value can match a sibling is via owner/repo against gitOrg — and
    // here the repo names (`ci`) don't equal the sibling basenames
    // (`orga-ci` / `orgb-ci`), so neither sibling matches. Result: no false
    // positive from basename collision.
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN --repo orgA/ci -b x', '/unrelated/x'),
        makeEntry('gh secret set NPM_TOKEN --repo orgB/ci -b y', '/unrelated/y'),
      ],
      [orgACi, orgBCi],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(0);
  });

  it('matches owner/repo to the right sibling and not the same-basename other org', async () => {
    // Two siblings both named `ci` at the dir level but in different orgs.
    // orgA/ci and orgB/ci each bind to exactly one sibling (their own org),
    // so only ONE sibling matches each spec — not enough for the 2-sibling
    // threshold, confirming specs don't cross-bind by basename alone.
    const orgACi: SiblingRepo = { path: '/repos/a/ci', name: 'ci', gitOrg: 'orgA' };
    const orgBCi: SiblingRepo = { path: '/repos/b/ci', name: 'ci', gitOrg: 'orgB' };
    const ctx = makeCtx(
      [makeEntry('gh secret set NPM_TOKEN --repo orgA/ci -b x', '/unrelated/x')],
      [orgACi, orgBCi],
    );
    // Only orgA/ci is in history -> only the orgA sibling matches -> 1 sibling,
    // below threshold. If basename collision were still present, BOTH `ci`
    // siblings would match and the check would (wrongly) fire.
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(0);
  });

  it('skips a multi-word double-quoted flag value when hunting for the NAME', async () => {
    // `-b "two words"` splits into two whitespace tokens. Skipping only one
    // would return `words"` as the secret name -- a garbage name that can
    // never match across siblings. The whole quoted value must be consumed
    // so NPM_TOKEN is captured.
    const ctx = makeCtx(
      [
        makeEntry('gh secret set -b "two words" NPM_TOKEN', '/repos/foo'),
        makeEntry('gh secret set -b "two words" NPM_TOKEN', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
    expect(issues[0].message).not.toContain('words');
  });

  it('skips a multi-word single-quoted flag value when hunting for the NAME', async () => {
    const ctx = makeCtx(
      [
        makeEntry("gh secret set -b 'three quoted words' NPM_TOKEN", '/repos/foo'),
        makeEntry("gh secret set -b 'three quoted words' NPM_TOKEN", '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
    expect(issues[0].message).not.toContain('quoted');
  });

  it('does not let a project-less entry mark the current project as having the secret', async () => {
    // Codex CLI occasionally writes neither `project` nor `cwd`; the scanner
    // keeps those entries with project ''. normalizePath('') resolves to the
    // linter's cwd, so without a guard a project-less `gh secret set` would
    // count as "current project has the secret" whenever ctxlint lints the
    // current directory -- suppressing the real missing-secret finding.
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN -b xxx', ''),
        makeEntry('gh secret set NPM_TOKEN -b yyy', '/repos/foo'),
        makeEntry('gh secret set NPM_TOKEN -b zzz', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
      process.cwd(),
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
  });

  // Regression for the substring-match false-positive: `ctxlint-old` should
  // not count as "current has the secret" when current is `ctxlint`.
  it('does not treat basename-substring sibling as current project', async () => {
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN -b xxx', '/repos/ctxlint-old'),
        makeEntry('gh secret set NPM_TOKEN -b yyy', '/repos/foo'),
        makeEntry('gh secret set NPM_TOKEN -b zzz', '/repos/bar'),
      ],
      [makeSibling('ctxlint-old'), makeSibling('foo'), makeSibling('bar')],
      '/repos/ctxlint',
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
  });

  it('binds a --repo command to that repo only, not to the directory it was typed in', async () => {
    // One command typed in sibling foo, aimed at bar. It is evidence about bar
    // alone; counting foo too turned one command into "set on 2 siblings".
    const ctx = makeCtx(
      [makeEntry('gh secret set NPM_TOKEN --repo org/bar -b x', '/repos/foo')],
      [makeSibling('foo'), makeSibling('bar')],
    );
    expect(await checkMissingSecret(ctx)).toHaveLength(0);
  });

  it('does not count a --repo command typed in the current project as the current project having it', async () => {
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN -b x', '/repos/foo'),
        makeEntry('gh secret set NPM_TOKEN -b y', '/repos/bar'),
        makeEntry('gh secret set NPM_TOKEN --repo org/other -b z', '/repos/current'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('(foo, bar)');
  });

  it('skips an unquoted $(...) body when hunting for the NAME', async () => {
    const ctx = makeCtx(
      [
        makeEntry('gh secret set -b $(echo ghp_x | tr a-z A-Z) NPM_TOKEN', '/repos/foo'),
        makeEntry('gh secret set -b `cat token.txt | head -1` NPM_TOKEN', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"NPM_TOKEN"');
    expect(issues[0].message).not.toContain('ghp_x');
  });

  it('does not take a --repo from a later command chained on the same line', async () => {
    const ctx = makeCtx(
      [
        makeEntry(
          'gh secret set NPM_TOKEN -b x && gh pr create --repo org/elsewhere',
          '/repos/foo',
        ),
        makeEntry('gh secret set NPM_TOKEN -b y', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    const issues = await checkMissingSecret(ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('(foo, bar)');
  });

  it("counts a secret the agent set in this project's transcript", async () => {
    // history.jsonl holds only what the user typed; an agent-run
    // `gh secret set` lives in the transcript and is just as real.
    const current = '/repos/current';
    const dir = join(home, '.claude', 'projects', encodeProjectDir(current));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 's.jsonl'),
      `${JSON.stringify({
        type: 'assistant',
        timestamp: '2026-01-01T00:00:00.000Z',
        sessionId: 's1',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Bash',
              id: 't1',
              input: { command: 'gh secret set NPM_TOKEN -b x' },
            },
          ],
        },
      })}\n`,
    );
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN -b x', '/repos/foo'),
        makeEntry('gh secret set NPM_TOKEN -b y', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
      current,
    );
    expect(await checkMissingSecret(ctx)).toHaveLength(0);
  });

  it('does not bind an org-level secret to the directory it was typed in', async () => {
    const ctx = makeCtx(
      [
        makeEntry('gh secret set NPM_TOKEN --org acme -b x', '/repos/foo'),
        makeEntry('gh secret set NPM_TOKEN --org acme -b y', '/repos/bar'),
      ],
      [makeSibling('foo'), makeSibling('bar')],
    );
    expect(await checkMissingSecret(ctx)).toHaveLength(0);
  });
});
