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
