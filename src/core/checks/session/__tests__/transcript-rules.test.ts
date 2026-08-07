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
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: false }] },
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
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: '', is_error: false }] },
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

function edits(n: number, branch = 'main', from = 0) {
  return Array.from({ length: n }, (_, i) => edit(`/repo/x/file${from + i}.ts`, branch)).flat();
}

/** Write a fixture transcript and point HOME at it for the duration of `run`. */
async function withProject<T>(records: unknown[], run: (ctx: SessionContext) => Promise<T>): Promise<T> {
  const project = `/repo/proj-${++seq}`;
  const home = mkdtempSync(join(tmpdir(), 'ctxlint-tr-'));
  roots.push(home);
  const dir = join(home, '.claude', 'projects', encodeProjectDir(project));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 's.jsonl'), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);

  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
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
            content: [{ type: 'tool_use', name: 'Bash', id, input: { command: 'npx tsc --noEmit' } }],
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

  it('counts distinct files, not repeated edits to one file', async () => {
    const repeated = Array.from({ length: 20 }, () => edit('/repo/x/same.ts')).flat();
    const issues = await withProject(repeated, checkDefaultBranchAccumulation);
    expect(issues).toHaveLength(0);
  });
});
