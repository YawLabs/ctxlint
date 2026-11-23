import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkSharedTempPath } from '../checks/session/shared-temp-path.js';
import { encodeProjectDir } from '../session-parser.js';
import { clearTranscriptCache, readProjectTranscript, turnsCarried } from '../transcript.js';
import type { SessionContext } from '../types.js';
import { countTokens } from '../../utils/tokens.js';

const roots: string[] = [];

afterEach(() => {
  clearTranscriptCache();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/**
 * Build a fake `~/.claude/projects/<encoded>/<uuid>.jsonl` and return the home
 * to point the reader at. Records are written in the same shape Claude Code
 * emits, so this exercises the real parse path rather than a hand-shaped stub.
 */
function withTranscript(project: string, records: unknown[]): string {
  const home = mkdtempSync(join(tmpdir(), 'ctxlint-transcript-'));
  roots.push(home);
  const dir = join(home, '.claude', 'projects', encodeProjectDir(project));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'session-1.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
  );
  return home;
}

let seq = 0;
function bash(command: string, id?: string) {
  return {
    type: 'assistant',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString(),
    sessionId: 's1',
    gitBranch: 'main',
    message: {
      content: [{ type: 'tool_use', name: 'Bash', id: id ?? `t${seq}`, input: { command } }],
    },
  };
}

function result(toolUseId: string, content: string, isError = false) {
  return {
    type: 'user',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString(),
    sessionId: 's1',
    message: {
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  };
}

function ctx(project: string): SessionContext {
  return {
    history: [],
    memories: [],
    siblings: [],
    currentProject: project,
    providers: ['claude-code'],
  };
}

describe('readProjectTranscript', () => {
  it('extracts agent commands, prose, writes, and pairs results', async () => {
    const project = '/repo/demo';
    const home = withTranscript(project, [
      bash('git status', 'a1'),
      result('a1', 'On branch main'),
      bash('npx biome check src/', 'a2'),
      // The crash signature: a result with no output at all.
      result('a2', ''),
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:05:00.000Z',
        sessionId: 's1',
        gitBranch: 'main',
        message: { content: [{ type: 'text', text: 'lint is clean' }] },
      },
      {
        type: 'assistant',
        timestamp: '2026-01-01T00:06:00.000Z',
        sessionId: 's1',
        gitBranch: 'main',
        message: {
          content: [
            { type: 'tool_use', name: 'Edit', id: 'w1', input: { file_path: '/repo/demo/a.ts' } },
          ],
        },
      },
    ]);

    const read = await readProjectTranscript(project, home);
    const commands = read.events.filter((e) => e.kind === 'command');
    expect(commands.map((c) => c.text)).toEqual(['git status', 'npx biome check src/']);
    // The result pairing is what lets a check tell "ran and found nothing" from
    // "died before emitting anything".
    expect(commands[0].emptyOutput).toBe(false);
    expect(commands[1].emptyOutput).toBe(true);
    expect(read.events.some((e) => e.kind === 'assistant-text' && e.text === 'lint is clean')).toBe(
      true,
    );
    expect(read.events.some((e) => e.kind === 'file-write' && e.text === '/repo/demo/a.ts')).toBe(
      true,
    );
    expect(read.events[0].gitBranch).toBe('main');
    expect(read.truncated).toBe(false);
  });

  it('returns empty for a project with no transcripts rather than throwing', async () => {
    const read = await readProjectTranscript(
      '/repo/nonexistent',
      mkdtempSync(join(tmpdir(), 'x-')),
    );
    expect(read.events).toEqual([]);
    expect(read.filesRead).toBe(0);
  });

  it('skips malformed lines instead of discarding the file', async () => {
    const project = '/repo/malformed';
    const home = mkdtempSync(join(tmpdir(), 'ctxlint-transcript-'));
    roots.push(home);
    const dir = join(home, '.claude', 'projects', encodeProjectDir(project));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's.jsonl'), `{not json\n${JSON.stringify(bash('echo ok', 'z1'))}\n`);
    const read = await readProjectTranscript(project, home);
    expect(read.events.filter((e) => e.kind === 'command').map((e) => e.text)).toEqual(['echo ok']);
  });
});

describe('readProjectTranscript: Reads and turns', () => {
  function asst(
    msgId: string | undefined,
    blocks: unknown[],
    extra: Record<string, unknown> = {},
    model?: string,
  ) {
    return {
      type: 'assistant',
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString(),
      sessionId: 's1',
      gitBranch: 'main',
      ...extra,
      message: { ...(msgId ? { id: msgId } : {}), ...(model ? { model } : {}), content: blocks },
    };
  }
  const text = (t: string) => ({ type: 'text', text: t });
  const readUse = (id: string, input: Record<string, unknown>) => ({
    type: 'tool_use',
    name: 'Read',
    id,
    input,
  });
  function readResult(id: string, content: string, file?: { filePath: string; numLines: number }) {
    return {
      ...result(id, content),
      ...(file
        ? { toolUseResult: { type: 'text', file: { ...file, content: '', startLine: 1 } } }
        : {}),
    };
  }

  it('records each Read, whether it was partial, and the size of its result', async () => {
    const project = '/repo/reads';
    const body = '1\tconst a = 1;\n2\tconst b = 2;\n3\texport { a, b };\n';
    const home = withTranscript(project, [
      asst('m1', [readUse('r1', { file_path: '/repo/reads/a.ts' })]),
      readResult('r1', body, { filePath: '/repo/reads/a.ts', numLines: 3 }),
      asst('m2', [readUse('r2', { file_path: '/repo/reads/b.ts', offset: 10 })]),
      readResult('r2', 'x'),
      asst('m3', [readUse('r3', { file_path: '/repo/reads/c.ts', limit: 50 })]),
      readResult('r3', 'x'),
      asst('m4', [readUse('r4', { file_path: '/repo/reads/d.pdf', pages: '1-3' })]),
      readResult('r4', 'x'),
      // A result record naming a different file must not lend its line count.
      asst('m5', [readUse('r5', { file_path: '/repo/reads/e.ts' })]),
      readResult('r5', body, { filePath: '/repo/reads/other.ts', numLines: 99 }),
    ]);

    const read = await readProjectTranscript(project, home);
    const reads = read.events.filter((e) => e.kind === 'file-read');
    expect(reads.map((e) => e.text)).toEqual([
      '/repo/reads/a.ts',
      '/repo/reads/b.ts',
      '/repo/reads/c.ts',
      '/repo/reads/d.pdf',
      '/repo/reads/e.ts',
    ]);
    expect(reads.map((e) => e.partial)).toEqual([false, true, true, true, false]);
    expect(reads.map((e) => e.toolUseId)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(reads[0].outputChars).toBe(body.length);
    expect(reads[0].outputTokens).toBe(countTokens(body));
    expect(reads[0].outputLines).toBe(3);
    expect(reads[4].outputLines).toBeUndefined();
  });

  it('counts a response written across several records as one turn', async () => {
    const project = '/repo/split';
    const home = withTranscript(project, [
      asst('m1', [text('Reading it.')]),
      asst('m1', [readUse('r1', { file_path: '/repo/split/a.ts' })]),
      readResult('r1', 'body'),
      asst('m2', [text('part one')]),
      asst('m2', [text('part two')]),
      asst('m2', [text('part three')]),
      asst('m3', [text('done')]),
    ]);

    const read = await readProjectTranscript(project, home);
    expect(read.sessionTurns.get('s1')).toBe(3);
    const ev = read.events.find((e) => e.kind === 'file-read');
    expect(ev?.turn).toBe(1);
    expect(turnsCarried(read, ev!)).toBe(2);
    expect(read.events.filter((e) => e.text.startsWith('part')).map((e) => e.turn)).toEqual([
      2, 2, 2,
    ]);
  });

  it('falls back to requestId, then to one turn per record, when message.id is missing', async () => {
    const project = '/repo/no-ids';
    const home = withTranscript(project, [
      asst(undefined, [text('a')], { requestId: 'req_1' }),
      asst(undefined, [text('b')], { requestId: 'req_1' }),
      asst(undefined, [text('c')]),
      asst(undefined, [text('d')]),
    ]);

    const read = await readProjectTranscript(project, home);
    expect(read.sessionTurns.get('s1')).toBe(3);
    expect(read.events.map((e) => e.turn)).toEqual([1, 1, 2, 3]);
  });

  it('does not count synthetic or sidechain records as turns', async () => {
    const project = '/repo/synthetic';
    const home = withTranscript(project, [
      asst('m1', [text('real')]),
      asst('syn1', [text('No response requested.')], {}, '<synthetic>'),
      asst('side1', [text('subagent work')], { isSidechain: true }),
      asst('m2', [text('real again')]),
    ]);

    const read = await readProjectTranscript(project, home);
    expect(read.sessionTurns.get('s1')).toBe(2);
    expect(read.events.map((e) => e.turn)).toEqual([1, 1, 1, 2]);
  });

  it('ends the carry at the next compaction', async () => {
    const project = '/repo/compact';
    const home = withTranscript(project, [
      asst('m1', [readUse('r1', { file_path: '/repo/compact/a.ts' })]),
      readResult('r1', 'body'),
      asst('m2', [text('t2')]),
      {
        type: 'system',
        subtype: 'compact_boundary',
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString(),
        sessionId: 's1',
      },
      asst('m3', [readUse('r2', { file_path: '/repo/compact/b.ts' })]),
      readResult('r2', 'body'),
      asst('m4', [text('t4')]),
      asst('m5', [text('t5')]),
    ]);

    const read = await readProjectTranscript(project, home);
    expect(read.sessionCompactions.get('s1')).toEqual([2]);
    const [before, after] = read.events.filter((e) => e.kind === 'file-read');
    expect(turnsCarried(read, before)).toBe(1);
    expect(turnsCarried(read, after)).toBe(2);
  });
});

describe('session/shared-temp-path reaches agent-run commands', () => {
  it('fires on a write/read pair the AGENT ran, which history.jsonl never records', async () => {
    // This is the regression that matters: before the transcript reader the
    // rule only saw user-typed prompts, so the incident it was written for --
    // an agent backing up package.json to a shared /tmp path and restoring
    // from it -- could never have been detected.
    const project = '/repo/incident';
    const home = withTranscript(project, [
      bash(`node -e 'fs.writeFileSync("/tmp/pkg.bak", fs.readFileSync("package.json"))'`, 'b1'),
      result('b1', ''),
      bash('npm pack --dry-run', 'b2'),
      result('b2', 'ok'),
      bash('cp /tmp/pkg.bak package.json', 'b3'),
      result('b3', ''),
    ]);

    // The check resolves home itself, so redirect it the same way the other
    // home-reading session checks are tested. CLAUDE_CONFIG_DIR outranks
    // HOME, so an ambient one must be cleared or the real corpus is read.
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    try {
      const issues = await checkSharedTempPath(ctx(project));
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('/tmp/pkg.bak');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
      if (prevConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = prevConfig;
    }
  });
});

describe('readProjectTranscript: caps keep the newest records', () => {
  it('keeps the TAIL of a transcript that exceeds the line cap, and says it was capped', async () => {
    const project = '/repo/tail';
    const records = Array.from({ length: 6 }, (_, i) => bash(`echo ${i}`, `c${i}`));
    const home = withTranscript(project, records);

    const read = await readProjectTranscript(project, home, { maxLines: 3 });

    // The newest three survive -- the oldest are what a cap should give up.
    expect(read.events.map((e) => e.text)).toEqual(['echo 3', 'echo 4', 'echo 5']);
    expect(read.truncated).toBe(true);
  });

  it('spends the line budget on the newest transcript first', async () => {
    const project = '/repo/budget';
    const home = mkdtempSync(join(tmpdir(), 'ctxlint-transcript-'));
    roots.push(home);
    const dir = join(home, '.claude', 'projects', encodeProjectDir(project));
    mkdirSync(dir, { recursive: true });
    const oldFile = join(dir, 'old.jsonl');
    const newFile = join(dir, 'new.jsonl');
    writeFileSync(oldFile, `${JSON.stringify(bash('old cmd', 'o1'))}\n`);
    writeFileSync(
      newFile,
      `${[bash('new 1', 'n1'), bash('new 2', 'n2')].map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    const { utimesSync } = await import('node:fs');
    utimesSync(oldFile, new Date(2020, 0, 1), new Date(2020, 0, 1));

    const read = await readProjectTranscript(project, home, { maxLines: 2 });

    expect(read.events.map((e) => e.text).sort()).toEqual(['new 1', 'new 2']);
    expect(read.filesRead).toBe(1);
    expect(read.truncated).toBe(true);
  });

  it('marks events from sidechain (subagent) records', async () => {
    const project = '/repo/side';
    const home = withTranscript(project, [
      { ...bash('main cmd', 'm1') },
      { ...bash('sub cmd', 's1'), isSidechain: true },
    ]);
    const read = await readProjectTranscript(project, home);
    expect(read.events.map((e) => [e.text, e.sidechain === true])).toEqual([
      ['main cmd', false],
      ['sub cmd', true],
    ]);
  });
});

describe('readProjectTranscript: config dir', () => {
  it('reads CLAUDE_CONFIG_DIR/projects when no home is passed', async () => {
    const project = '/repo/config-dir';
    const home = withTranscript(project, [bash('from override', 'x1')]);
    const prev = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    };
    const elsewhere = mkdtempSync(join(tmpdir(), 'ctxlint-nohome-'));
    roots.push(elsewhere);
    process.env.HOME = elsewhere;
    process.env.USERPROFILE = elsewhere;
    process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');
    try {
      const read = await readProjectTranscript(project);
      expect(read.events.map((e) => e.text)).toEqual(['from override']);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('readProjectTranscript: stream cleanup (mocked fs)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('destroys every stream it opens, including ones it stops reading early', async () => {
    const project = '/repo/fd';
    const home = withTranscript(
      project,
      Array.from({ length: 5 }, (_, i) => bash(`echo ${i}`, `f${i}`)),
    );
    const opened: Array<{ destroyed: boolean }> = [];
    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      return {
        ...actual,
        createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
          const s = actual.createReadStream(...args);
          opened.push(s);
          return s;
        },
      };
    });
    const mod = await import('../transcript.js');
    await mod.readProjectTranscript(project, home, { maxLines: 2 });
    expect(opened.length).toBeGreaterThan(0);
    expect(opened.every((s) => s.destroyed)).toBe(true);
  });
});
