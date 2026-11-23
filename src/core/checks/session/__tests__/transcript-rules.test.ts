import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeProjectDir } from '../../../session-parser.js';
import { clearTranscriptCache } from '../../../transcript.js';
import type { SessionContext } from '../../../types.js';
import { checkDefaultBranchAccumulation } from '../default-branch-accumulation.js';
import { checkUnverifiedGateClaimedClean } from '../unverified-gate-claimed-clean.js';

const roots: string[] = [];
const PROJECT = '/repo/x';
let seq = 0;

afterEach(() => {
  clearTranscriptCache();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function stamp(): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString();
}

function bash(command: string, branch = 'main') {
  const id = `t${seq}`;
  return [
    {
      type: 'assistant',
      timestamp: stamp(),
      sessionId: 's1',
      gitBranch: branch,
      message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] },
    },
    {
      type: 'user',
      timestamp: stamp(),
      sessionId: 's1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }],
      },
    },
  ];
}

/** A gate invocation that produced nothing -- the crash signature. */
function silentGate(command: string, branch = 'main') {
  const id = `t${seq}`;
  return [
    {
      type: 'assistant',
      timestamp: stamp(),
      sessionId: 's1',
      gitBranch: branch,
      message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] },
    },
    {
      type: 'user',
      timestamp: stamp(),
      sessionId: 's1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: '', is_error: false }],
      },
    },
  ];
}

function say(text: string, branch = 'main') {
  return [
    {
      type: 'assistant',
      timestamp: stamp(),
      sessionId: 's1',
      gitBranch: branch,
      message: { content: [{ type: 'text', text }] },
    },
  ];
}

function edit(path: string, branch = 'main') {
  return [
    {
      type: 'assistant',
      timestamp: stamp(),
      sessionId: 's1',
      gitBranch: branch,
      message: {
        content: [{ type: 'tool_use', name: 'Edit', id: `w${seq}`, input: { file_path: path } }],
      },
    },
  ];
}

/** A Read call and its result. */
function readFile(path: string, branch = 'main') {
  const id = `r${++seq}`;
  return [
    {
      type: 'assistant',
      timestamp: stamp(),
      sessionId: 's1',
      gitBranch: branch,
      message: {
        content: [{ type: 'tool_use', name: 'Read', id, input: { file_path: path } }],
      },
    },
    {
      type: 'user',
      timestamp: stamp(),
      sessionId: 's1',
      message: {
        content: [{ type: 'tool_result', tool_use_id: id, content: 'contents', is_error: false }],
      },
    },
  ];
}

/** A gate run whose result carried `content`, optionally flagged as an error. */
function gate(command: string, content: string, isError = false) {
  const id = `g${++seq}`;
  return [
    {
      type: 'assistant',
      timestamp: stamp(),
      sessionId: 's1',
      gitBranch: 'main',
      message: { content: [{ type: 'tool_use', name: 'Bash', id, input: { command } }] },
    },
    {
      type: 'user',
      timestamp: stamp(),
      sessionId: 's1',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] },
    },
  ];
}

/** Re-stamp records into another session id. */
function inSession<T extends { sessionId?: string }>(sessionId: string, records: T[]): T[] {
  return records.map((r) => ({ ...r, sessionId }));
}

function edits(n: number, branch = 'main', from = 0) {
  return Array.from({ length: n }, (_, i) => edit(`/repo/x/file${from + i}.ts`, branch)).flat();
}

/** Write a fixture transcript and point HOME at it for the duration of `run`. */
async function withProject<T>(
  records: unknown[],
  run: (ctx: SessionContext) => Promise<T>,
  // Fixed by default: the edit helpers write under it. Each case gets its own
  // home, so the transcript cache cannot leak between cases.
  project = PROJECT,
): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'ctxlint-tr-'));
  roots.push(home);
  const dir = join(home, '.claude', 'projects', encodeProjectDir(project));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  const prevConfig = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // CLAUDE_CONFIG_DIR outranks HOME; an ambient one would read the real corpus.
  delete process.env.CLAUDE_CONFIG_DIR;
  clearTranscriptCache();
  try {
    return await run({
      history: [],
      memories: [],
      siblings: [],
      currentProject: project,
      providers: ['claude-code'],
    });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    clearTranscriptCache();
  }
}

describe('session/unverified-gate-claimed-clean', () => {
  it('flags "lint clean" after a gate that produced no output', async () => {
    const issues = await withProject(
      [...silentGate('npx biome check src/'), ...say('Lint is clean, nothing to fix.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('lint');
    expect(issues[0].detail).toContain('biome check');
  });

  it('stays clean when the session labels the gate honestly', async () => {
    // This is the correct outcome, and it must not be flagged -- otherwise the
    // rule punishes the exact behaviour it is trying to produce.
    const issues = await withProject(
      [
        ...silentGate('npx biome check src/'),
        ...say('Lint is UNVERIFIED -- the runner crashed with no output.'),
      ],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('stays clean when the gate genuinely produced a result', async () => {
    const issues = await withProject(
      [...bash('npx biome check src/'), ...say('Lint is clean.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('flags a gate whose invocation errored', async () => {
    const id = `e${++seq}`;
    const issues = await withProject(
      [
        {
          type: 'assistant',
          timestamp: stamp(),
          sessionId: 's1',
          gitBranch: 'main',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', id, input: { command: 'npx tsc --noEmit' } },
            ],
          },
        },
        {
          type: 'user',
          timestamp: stamp(),
          sessionId: 's1',
          message: {
            content: [{ type: 'tool_result', tool_use_id: id, content: 'boom', is_error: true }],
          },
        },
        ...say('Typecheck passes.'),
      ],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('typecheck');
  });

  it('does not flag when a later successful re-run supersedes the bad one', async () => {
    const issues = await withProject(
      [
        ...silentGate('npx biome check src/'),
        ...bash('npx biome check src/'),
        ...say('Lint is clean.'),
      ],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('still flags the claim when Reads sit between the failed gate and it', async () => {
    // The reader began emitting Read events after this rule shipped. Its
    // adjacency window counts events, so without excluding them fifteen Reads
    // would push this claim out of range and silence a real finding.
    const issues = await withProject(
      [
        ...silentGate('npx biome check src/'),
        ...Array.from({ length: 15 }, (_, i) => readFile(`/repo/x/f${i}.ts`)).flat(),
        ...say('Lint is clean.'),
      ],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(1);
  });

  it('does not flag a claim far away from the failed gate', async () => {
    // Build the records INSIDE the literal: the helpers stamp timestamps from a
    // shared counter as they are called, so hoisting the filler to its own
    // `const` would date it BEFORE the gate and make this test assert the
    // opposite of what it reads like.
    const issues = await withProject(
      [
        ...silentGate('npx biome check src/'),
        ...Array.from({ length: 15 }, () => say('Working on it.')).flat(),
        ...say('Lint is clean.'),
      ],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });
});

describe('session/unverified-gate-claimed-clean: silent-on-success tools', () => {
  it('does not treat empty tsc output as unverified -- tsc prints nothing on success', async () => {
    const issues = await withProject(
      [...silentGate('npx tsc --noEmit'), ...say('Typecheck passes.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('does not treat empty eslint output as unverified', async () => {
    const issues = await withProject(
      [...silentGate('eslint src/'), ...say('Lint is clean.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('flags a silent-on-success tool whose output carries a crash signature', async () => {
    const issues = await withProject(
      [...gate('npx tsc --noEmit', 'Segmentation fault (core dumped)'), ...say('Typecheck clean.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('crash');
  });

  it('flags a crash signature even when the output is not empty', async () => {
    const issues = await withProject(
      [...gate('pnpm lint', 'exit code 3221225477'), ...say('Lint passes.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(1);
  });
});

describe('session/unverified-gate-claimed-clean: gate recognition', () => {
  it('does not read `rm -rf build` as a build gate', async () => {
    const issues = await withProject(
      [...gate('rm -rf build', 'rm: cannot remove', true), ...say('The build passes.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('does not read `mkdir -p build/out` as a build gate', async () => {
    const issues = await withProject(
      [...silentGate('mkdir -p build/out'), ...say('Build succeeded.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('does not read `git add src/foo.test.ts` as a test gate', async () => {
    const issues = await withProject(
      [...gate('git add src/foo.test.ts', 'fatal: oops', true), ...say('Tests passed.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('recognizes a package-manager script run in a chain', async () => {
    const issues = await withProject(
      [...gate('cd pkg && pnpm run test', 'ERR', true), ...say('All tests pass.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("'test'");
  });
});

describe('session/unverified-gate-claimed-clean: claim matching', () => {
  it('does not fire on a negated claim', async () => {
    const issues = await withProject(
      [...gate('npm test', 'FAIL', true), ...say('The tests are still not passing.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('does not fire when the passing clause is about a different gate', async () => {
    const issues = await withProject(
      [...gate('npm test', 'FAIL', true), ...say('2 tests failed; the build passes though.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('does not fire on stated future intent', async () => {
    const issues = await withProject(
      [...gate('npm test', 'FAIL', true), ...say('I will make the tests green next.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('reads `make` as intent only in verb position', async () => {
    for (const text of ['Make the tests pass, then ship.', 'Make tests pass first.']) {
      const issues = await withProject(
        [...gate('npm test', 'FAIL', true), ...say(text)],
        checkUnverifiedGateClaimedClean,
      );
      expect(issues, text).toHaveLength(0);
    }
  });

  it('still fires on a claim that names a make target', async () => {
    const issues = await withProject(
      [...silentGate('make lint'), ...say('`make lint` is clean now.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('lint');
  });

  it('does not tie a lint failure to a claim about tests', async () => {
    const issues = await withProject(
      [...silentGate('npx biome check src/'), ...say('Tests passed.')],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });

  it('does not pair a failed gate in one session with a claim in another', async () => {
    // Two sessions interleaved in time: the crashed lint in s1 and the claim
    // in s2 (about its own run) are unrelated.
    const issues = await withProject(
      [...silentGate('npx biome check src/'), ...inSession('s2', say('Lint is clean.'))],
      checkUnverifiedGateClaimedClean,
    );
    expect(issues).toHaveLength(0);
  });
});

describe('session/default-branch-accumulation', () => {
  it('flags many uncommitted edits on main', async () => {
    const issues = await withProject(edits(20), checkDefaultBranchAccumulation);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("on 'main'");
    expect(issues[0].message).toContain('20 files');
  });

  it('stays clean when the session branches first', async () => {
    const issues = await withProject(
      [...bash('git checkout -b feat/x'), ...edits(20, 'feat/x')],
      checkDefaultBranchAccumulation,
    );
    expect(issues).toHaveLength(0);
  });

  it('stays clean below the threshold -- the defect is accumulation, not the first write', async () => {
    const issues = await withProject(edits(3), checkDefaultBranchAccumulation);
    expect(issues).toHaveLength(0);
  });

  it('resets on an intervening commit', async () => {
    const issues = await withProject(
      [...edits(8, 'main', 0), ...bash('git commit -m wip'), ...edits(8, 'main', 100)],
      checkDefaultBranchAccumulation,
    );
    expect(issues).toHaveLength(0);
  });

  it('does not treat `git commit --dry-run` as landing the work', async () => {
    const issues = await withProject(
      [...edits(12), ...bash('git commit --dry-run')],
      checkDefaultBranchAccumulation,
    );
    expect(issues).toHaveLength(1);
  });

  it("does not let a Read's branch stamp decide where an unstamped write lands", async () => {
    // Pins pre-Read behaviour: the branch tracker takes the stamp of every
    // event it walks, so a Read stamped `main` would otherwise pull these
    // unstamped writes (last observed branch: feat/x) onto the default branch.
    const issues = await withProject(
      [
        ...bash('git status', 'feat/x'),
        ...readFile('/repo/x/README.md', 'main'),
        ...Array.from({ length: 12 }, (_, i) => edit(`/repo/x/u${i}.ts`, '')).flat(),
      ],
      checkDefaultBranchAccumulation,
    );
    expect(issues).toHaveLength(0);
  });

  it('counts only writes inside the current project', async () => {
    // Scratchpad files, ~/.claude memory and sibling repos are not this
    // repo's working tree.
    const outside = Array.from({ length: 20 }, (_, i) => edit(`/elsewhere/f${i}.ts`)).flat();
    const issues = await withProject(outside, checkDefaultBranchAccumulation);
    expect(issues).toHaveLength(0);
  });

  it('names the branch the writes landed on, not the last stamp seen', async () => {
    const issues = await withProject(
      [...edits(12, 'master'), ...bash('git status', 'feat/later')],
      checkDefaultBranchAccumulation,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain("on 'master'");
  });

  it('resets on `git switch <branch>` and `git checkout <branch>` once a stamp shows the move', async () => {
    for (const away of ['git switch feat/x', 'git checkout feat/x']) {
      const issues = await withProject(
        // The command's own stamp predates the move; the next stamp confirms it.
        [
          ...edits(6, 'main', 0),
          ...bash(away),
          ...bash('git status', 'feat/x'),
          ...bash('git switch main', 'feat/x'),
          ...edits(6, 'main', 100),
        ],
        checkDefaultBranchAccumulation,
      );
      expect(issues, away).toHaveLength(0);
    }
  });

  it('resets immediately when a branch is created (`-b`, `-c`, `worktree add`)', async () => {
    for (const away of [
      'git checkout -b feat/x',
      'git switch -c feat/x',
      'git worktree add ../wt feat/x',
    ]) {
      const issues = await withProject(
        [...edits(6, 'main', 0), ...bash(away), ...edits(6, 'main', 100)],
        checkDefaultBranchAccumulation,
      );
      expect(issues, away).toHaveLength(0);
    }
  });

  it('does not reset when the next stamp is still the default branch', async () => {
    // A file restore without `--`, a restore from an older revision, and a
    // switch TO main while already on main all leave the session on main.
    for (const cmd of [
      'git checkout package.json',
      'git checkout HEAD~1 src/a.ts',
      'git switch main',
      'git checkout main',
    ]) {
      const issues = await withProject(
        [...edits(6, 'main', 0), ...bash(cmd), ...edits(6, 'main', 100)],
        checkDefaultBranchAccumulation,
      );
      expect(issues, cmd).toHaveLength(1);
      expect(issues[0].message, cmd).toContain('12 files');
    }
  });

  it('never treats an argument naming an existing file as a branch', async () => {
    // Even when a later stamp is off the default branch (the shared checkout
    // was moved by something else), restoring `package.json` is not this
    // session leaving main.
    const project = mkdtempSync(join(tmpdir(), 'ctxlint-dba-'));
    roots.push(project);
    writeFileSync(join(project, 'package.json'), '{}');
    const under = (n: number, from: number) =>
      Array.from({ length: n }, (_, i) => edit(join(project, `f${from + i}.ts`))).flat();
    const issues = await withProject(
      [
        ...under(6, 0),
        ...bash('git checkout package.json'),
        ...bash('git status', 'feat/other'),
        ...under(6, 100),
      ],
      checkDefaultBranchAccumulation,
      project,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('12 files');
  });

  it('does not treat `git checkout -- <path>` as leaving the branch', async () => {
    const issues = await withProject(
      [...edits(6, 'main', 0), ...bash('git checkout -- src/a.ts'), ...edits(6, 'main', 100)],
      checkDefaultBranchAccumulation,
    );
    expect(issues).toHaveLength(1);
  });

  it('does not let a failed commit clear the pending set', async () => {
    const issues = await withProject(
      [
        ...edits(6, 'main', 0),
        ...gate('git commit -m wip', 'error: pre-commit hook failed', true),
        ...edits(6, 'main', 100),
      ],
      checkDefaultBranchAccumulation,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('12 files');
  });

  it('starts each session with an empty pending set', async () => {
    const issues = await withProject(
      [...edits(6, 'main', 0), ...inSession('s2', edits(6, 'main', 100))],
      checkDefaultBranchAccumulation,
    );
    expect(issues).toHaveLength(0);
  });

  it('counts distinct files, not repeated edits to one file', async () => {
    const repeated = Array.from({ length: 20 }, () => edit('/repo/x/same.ts')).flat();
    const issues = await withProject(repeated, checkDefaultBranchAccumulation);
    expect(issues).toHaveLength(0);
  });
});
