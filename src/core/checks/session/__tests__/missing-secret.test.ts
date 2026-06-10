import { describe, it, expect } from 'vitest';
import { checkMissingSecret } from '../missing-secret.js';
import type { SessionContext, HistoryEntry, SiblingRepo } from '../../../types.js';

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
    expect(issues[0].severity).toBe('error');
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
});
