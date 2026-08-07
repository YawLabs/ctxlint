import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import simpleGit from 'simple-git';
import { checkUnresolvableSha, extractShaCitations } from '../unresolvable-sha.js';
import { encodeProjectDir } from '../../../session-parser.js';
import { resetGit } from '../../../../utils/git.js';
import type { MemoryEntry, SessionContext } from '../../../types.js';

describe('extractShaCitations', () => {
  const shas = (text: string) => extractShaCitations(text).map((c) => c.sha);

  it('extracts cue-preceded hex tokens', () => {
    expect(shas('CI was removed in commit `1b18b85` last month.')).toEqual(['1b18b85']);
    expect(shas('The migration landed in deadbee.')).toEqual(['deadbee']);
    expect(shas('**Artifacts (state as of 2026-06-29, 14 commits, HEAD 5b0b55d):**')).toEqual([
      '5b0b55d',
    ]);
    expect(shas('aws-mcp release.yml (committed in fc750e4).')).toEqual(['fc750e4']);
  });

  it('requires a citation cue -- bare hex prose is not a commit claim', () => {
    // `beadfaced` is nine hex characters AND an English-ish word. It does not
    // resolve, so a resolve-only rule reports it; the cue requirement is what
    // keeps it quiet.
    expect(shas('Colour tokens: `#a1b2c3` and `beadfaced` appear in the theme.')).toEqual([]);
    expect(shas('The cache key is `abcdefa` in the config below.')).toEqual([]);
  });

  it('ignores UUIDs, which every memory carries in frontmatter', () => {
    expect(shas('originSessionId: 77bde817-610b-4f82-971d-1c2452b07917')).toEqual([]);
    // Even with a cue nearby, the UUID members are removed before extraction.
    expect(shas('commit for session 77bde817-610b-4f82-971d-1c2452b07917')).toEqual([]);
  });

  it('ignores digests, colours, decimals and version fragments', () => {
    expect(shas('deployed 2026-06-03, image commit `sha256:7e7b3ab9`')).toEqual([]);
    expect(shas('commit 0xdeadbeef in the loader')).toEqual([]);
    expect(shas('commit 1045755 in the order table')).toEqual([]);
    expect(shas('released 26.1.1234567 of the sdk')).toEqual([]);
  });

  it('ignores anything inside a fenced code block', () => {
    expect(shas('```bash\n# commit\ngit show 1234abc\n```\n')).toEqual([]);
  });

  it('is short enough to be a token but too short to be a SHA below 7 chars', () => {
    expect(shas('commit abcdef here')).toEqual([]);
  });

  it('dedupes repeated citations', () => {
    expect(shas('commit deadbee\nsee commit deadbee again')).toEqual(['deadbee']);
  });
});

describe('checkUnresolvableSha (real git)', () => {
  let tmpDir: string;
  let repo: string;
  let liveSha: string;

  // projectDir is the ENCODED Claude Code directory name, not a filesystem
  // path -- a raw path here makes projectDirMatchesPath return false, the
  // memory list empties, and every assertion goes green for the wrong reason.
  function memory(content: string, name = 'notes'): MemoryEntry {
    return {
      filePath: path.join(repo, '.claude', 'memory', `${name}.md`),
      projectDir: encodeProjectDir(repo.replace(/\\/g, '/')),
      name,
      content,
      referencedPaths: [],
    };
  }

  function ctx(memories: MemoryEntry[]): SessionContext {
    return {
      history: [],
      memories,
      siblings: [],
      currentProject: repo,
      providers: ['claude-code'],
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-sha-'));
    repo = fs.realpathSync(tmpDir);
    const git = simpleGit(repo);
    await git.raw(['init', '-b', 'main']);
    await git.addConfig('user.email', 'test@example.com');
    await git.addConfig('user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'hello');
    await git.add('a.txt');
    await git.commit('initial');
    liveSha = (await git.revparse(['--short=7', 'HEAD'])).trim();
    resetGit();
  }, 30000);

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
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10000);

  it('stays silent on a SHA that resolves', async () => {
    const issues = await checkUnresolvableSha(ctx([memory(`Landed in commit ${liveSha}.`)]));
    expect(issues).toEqual([]);
  }, 30000);

  it('flags a SHA that does not resolve', async () => {
    const issues = await checkUnresolvableSha(ctx([memory('CI was removed in commit `1b18b85`.')]));
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].check).toBe('session-unresolvable-sha');
    expect(issues[0].ruleId).toBe('session-unresolvable-sha/unresolvable-sha');
    expect(issues[0].message).toContain('1b18b85');
  }, 30000);

  it('reports only the dead SHAs when a memory cites both', async () => {
    const issues = await checkUnresolvableSha(
      ctx([memory(`Landed in commit ${liveSha}, reverted in commit deadbee.`)]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('deadbee');
    expect(issues[0].message).not.toContain(liveSha);
  }, 30000);

  it('does not fire on the hex-shaped word that has no citation cue', async () => {
    const issues = await checkUnresolvableSha(
      ctx([memory('Colour tokens: `#a1b2c3` and `beadfaced` appear in the theme.')]),
    );
    expect(issues).toEqual([]);
  }, 30000);

  it('reports nothing outside a git repository', async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-nogit-'));
    try {
      const issues = await checkUnresolvableSha({
        history: [],
        memories: [
          {
            filePath: path.join(bare, 'm.md'),
            projectDir: encodeProjectDir(fs.realpathSync(bare).replace(/\\/g, '/')),
            name: 'm',
            content: 'removed in commit 1b18b85',
            referencedPaths: [],
          },
        ],
        siblings: [],
        currentProject: fs.realpathSync(bare),
        providers: ['claude-code'],
      });
      expect(issues).toEqual([]);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  }, 30000);
});
