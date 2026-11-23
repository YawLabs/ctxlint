import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { simpleGit } from 'simple-git';
import { checkStaleness } from '../staleness.js';
import { resetGit } from '../../../utils/git.js';
import type { ParsedContextFile } from '../../types.js';

// Real-git counterpart of staleness.test.ts (which mocks the git layer and so
// cannot see coordinate-space or range bugs between the check and git).

const DAY = 24 * 60 * 60 * 1000;
let tmpDir: string;
let repo: string;

async function commitAt(daysAgo: number, msg: string, files: Record<string, string>) {
  const when = new Date(Date.now() - daysAgo * DAY).toISOString();
  const git = simpleGit(repo);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    await git.add(rel);
  }
  // Plain execFile rather than simple-git's .env(): simple-git refuses an env
  // carrying variables a host may export (GIT_EDITOR, SSH_ASKPASS, ...).
  execFileSync('git', ['commit', '-q', '-m', msg], {
    cwd: repo,
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

function parsed(root: string, rel: string, refs: string[]): ParsedContextFile {
  return {
    filePath: path.join(root, rel),
    relativePath: rel,
    isSymlink: false,
    totalTokens: 10,
    totalLines: 1,
    content: '',
    sections: [],
    references: {
      paths: refs.map((value, i) => ({ value, line: i + 1, column: 1 })),
      commands: [],
    },
  };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-stale-git-'));
  repo = fs.realpathSync(tmpDir);
  const git = simpleGit(repo);
  await git.raw(['init', '-b', 'main']);
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  resetGit();
}, 60000);

afterEach(async () => {
  resetGit();
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}, 10000);

describe('checkStaleness against real git', { timeout: 90000 }, () => {
  it("does not count the doc's own commit as activity since it", async () => {
    // Doc and code committed together 40 days ago, nothing since: not stale.
    // `--since=<doc date>` is inclusive, so the shared commit used to count.
    await commitAt(40, 'doc + code', { 'CLAUDE.md': 'doc', 'src/x.ts': 'a' });
    const issues = await checkStaleness(parsed(repo, 'CLAUDE.md', ['src/x.ts']), repo);
    expect(issues).toEqual([]);
  });

  it('fires when a referenced file changed after the doc', async () => {
    await commitAt(40, 'doc + code', { 'CLAUDE.md': 'doc', 'src/x.ts': 'a' });
    await commitAt(1, 'code', { 'src/x.ts': 'b' });
    const issues = await checkStaleness(parsed(repo, 'CLAUDE.md', ['src/x.ts']), repo);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('staleness/stale');
    expect(issues[0].message).toContain('src/x.ts has 1 commits since');
  });

  it('works when projectRoot is a subdirectory of the repo', async () => {
    await commitAt(40, 'doc', { 'pkg/CLAUDE.md': 'doc', 'pkg/src/x.ts': 'a' });
    await commitAt(1, 'code', { 'pkg/src/x.ts': 'b' });
    resetGit();
    const pkg = path.join(repo, 'pkg');
    const issues = await checkStaleness(parsed(pkg, 'CLAUDE.md', ['src/x.ts']), pkg);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('src/x.ts has 1 commits since');
  });

  it("resolves ./ refs against the context file's directory, not the root", async () => {
    await commitAt(40, 'doc', {
      'packages/a/CLAUDE.md': 'doc',
      'packages/a/src/x.ts': 'a',
      'src/x.ts': 'root',
    });
    // Only the ROOT src/x.ts changes; packages/a/src/x.ts (what `./src/x.ts`
    // in packages/a/CLAUDE.md means) does not.
    await commitAt(1, 'root code', { 'src/x.ts': 'root 2' });
    const file = parsed(repo, 'packages/a/CLAUDE.md', ['./src/x.ts']);
    expect(await checkStaleness(file, repo)).toEqual([]);

    await commitAt(0.5, 'pkg code', { 'packages/a/src/x.ts': 'b' });
    const issues = await checkStaleness(file, repo);
    expect(issues).toHaveLength(1);
    // The label is the ref as written, not the resolved key.
    expect(issues[0].message).toContain('./src/x.ts has 1 commits since');
  });

  it('reports distinct commits in the detail (one commit touching three refs is one)', async () => {
    await commitAt(40, 'doc', { 'CLAUDE.md': 'doc', 'a.ts': '1', 'b.ts': '1', 'c.ts': '1' });
    await commitAt(1, 'all three', { 'a.ts': '2', 'b.ts': '2', 'c.ts': '2' });
    const issues = await checkStaleness(parsed(repo, 'CLAUDE.md', ['a.ts', 'b.ts', 'c.ts']), repo);
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toBe('1 total commit to referenced paths since last update.');
  });

  it('skips a shallow clone instead of judging truncated history', async () => {
    await commitAt(100, 'doc', { 'CLAUDE.md': 'doc', 'src/x.ts': 'a' });
    await commitAt(50, 'code 1', { 'src/x.ts': 'b' });
    await commitAt(40, 'code 2', { 'src/x.ts': 'c' });
    // Depth 2: the boundary commit (code 1) appears to add every file, so the
    // doc's "last commit" is code 1 and code 2 reads as activity since it.
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-stale-clone-')));
    try {
      const url = 'file://' + (process.platform === 'win32' ? '/' : '') + repo.replace(/\\/g, '/');
      await simpleGit(parent).raw(['clone', '--depth', '2', url, 'c']);
      const clone = path.join(parent, 'c');
      resetGit();
      expect(await checkStaleness(parsed(clone, 'CLAUDE.md', ['src/x.ts']), clone)).toEqual([]);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
