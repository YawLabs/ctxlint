import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSharedTempPath } from '../checks/session/shared-temp-path.js';
import { encodeProjectDir } from '../session-parser.js';
import { clearTranscriptCache, readProjectTranscript } from '../transcript.js';
import type { SessionContext } from '../types.js';

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
    message: { content: [{ type: 'tool_use', name: 'Bash', id: id ?? `t${seq}`, input: { command } }] },
  };
}

function result(toolUseId: string, content: string, isError = false) {
  return {
    type: 'user',
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString(),
    sessionId: 's1',
    message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] },
  };
}

function ctx(project: string): SessionContext {
  return { history: [], memories: [], siblings: [], currentProject: project, providers: ['claude-code'] };
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
          content: [{ type: 'tool_use', name: 'Edit', id: 'w1', input: { file_path: '/repo/demo/a.ts' } }],
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
    expect(read.events.some((e) => e.kind === 'assistant-text' && e.text === 'lint is clean')).toBe(true);
    expect(read.events.some((e) => e.kind === 'file-write' && e.text === '/repo/demo/a.ts')).toBe(true);
    expect(read.events[0].gitBranch).toBe('main');
    expect(read.truncated).toBe(false);
  });

  it('returns empty for a project with no transcripts rather than throwing', async () => {
    const read = await readProjectTranscript('/repo/nonexistent', mkdtempSync(join(tmpdir(), 'x-')));
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
    // home-reading session checks are tested.
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const issues = await checkSharedTempPath(ctx(project));
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('/tmp/pkg.bak');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    }
  });
});
