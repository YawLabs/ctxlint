import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readJsonlHistory } from '../session-scanner.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-ss-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonl(filePath: string, entries: unknown[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

describe('readJsonlHistory', () => {
  it('returns an empty array when the file does not exist', async () => {
    const entries = await readJsonlHistory({
      historyPath: path.join(tmpDir, 'missing.jsonl'),
      provider: 'claude-code',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });
    expect(entries).toEqual([]);
  });

  it('uses the first non-empty display field, in order', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [
      // display-only -> first field wins
      { display: 'd1', cwd: '/proj' },
      // command-only -> falls back to second field
      { command: 'c1', cwd: '/proj' },
      // both -> first field still wins
      { display: 'd2', command: 'c2', cwd: '/proj' },
      // empty display string falls through to command
      { display: '', command: 'c3', cwd: '/proj' },
      // neither -> dropped
      { cwd: '/proj' },
    ]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'codex-cli',
      displayFields: ['display', 'command'],
      projectFields: ['cwd'],
      requireProject: false,
    });

    expect(entries.map((e) => e.display)).toEqual(['d1', 'c1', 'd2', 'c3']);
  });

  it('uses the first non-empty project field, in order', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [
      { display: 'd', project: '/p1', cwd: '/c1' },
      { display: 'd', cwd: '/c2' },
      { display: 'd' },
    ]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'codex-cli',
      displayFields: ['display'],
      projectFields: ['project', 'cwd'],
      requireProject: false,
    });

    expect(entries.map((e) => e.project)).toEqual(['/p1', '/c2', '']);
  });

  it('drops entries with no project when requireProject is true', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [
      { display: 'kept', project: '/p' },
      { display: 'dropped' },
      { display: 'also-dropped', project: '' },
    ]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'claude-code',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });

    expect(entries.map((e) => e.display)).toEqual(['kept']);
  });

  it('keeps entries with empty project when requireProject is false', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [{ display: 'has-project', project: '/p' }, { display: 'no-project' }]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'codex-cli',
      displayFields: ['display'],
      projectFields: ['project', 'cwd'],
      requireProject: false,
    });

    expect(entries.map((e) => ({ display: e.display, project: e.project }))).toEqual([
      { display: 'has-project', project: '/p' },
      { display: 'no-project', project: '' },
    ]);
  });

  it('normalizes Windows backslashes in the project path', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [{ display: 'd', project: 'C:\\Users\\jeff\\proj' }]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'claude-code',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });

    expect(entries[0].project).toBe('C:/Users/jeff/proj');
  });

  it('stamps the configured provider on every entry', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [
      { display: 'a', project: '/p' },
      { display: 'b', project: '/p' },
    ]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'codex-cli',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });

    expect(entries.every((e) => e.provider === 'codex-cli')).toBe(true);
  });

  it('preserves timestamp and sessionId when present', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [{ display: 'd', project: '/p', timestamp: 1234567890, sessionId: 'sess-1' }]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'claude-code',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });

    expect(entries[0].timestamp).toBe(1234567890);
    expect(entries[0].sessionId).toBe('sess-1');
  });

  it('defaults timestamp to 0 and sessionId to "" when missing', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [{ display: 'd', project: '/p' }]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'claude-code',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });

    expect(entries[0].timestamp).toBe(0);
    expect(entries[0].sessionId).toBe('');
  });

  it('skips malformed JSON lines without aborting the whole file', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ display: 'first', project: '/p' }),
        '{ this is not json',
        JSON.stringify({ display: 'second', project: '/p' }),
      ].join('\n') + '\n',
    );

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'claude-code',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });

    expect(entries.map((e) => e.display)).toEqual(['first', 'second']);
  });
});

describe('detectProviders goose dir (win32, APPDATA unset)', () => {
  // AGENT_DIRS is computed at module-load time from process.platform and
  // process.env, so each case stubs the environment, then re-imports the
  // module fresh via vi.resetModules() + dynamic import.
  function stubPlatform(value: string) {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value, configurable: true });
    return () => {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    };
  }

  let scanRoot: string;
  let prevCwd: string;
  let prevAppData: string | undefined;
  let prevUserProfile: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    scanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-goose-'));
    prevCwd = process.cwd();
    prevAppData = process.env.APPDATA;
    prevUserProfile = process.env.USERPROFILE;
    prevHome = process.env.HOME;
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(scanRoot, { recursive: true, force: true });
  });

  it('does not match a cwd-relative Block/goose when APPDATA is empty on win32', async () => {
    // A project that happens to have its own Block/goose under cwd would be
    // mistaken for the user's goose data if the dir collapsed to the relative
    // 'Block/goose'. HOME/USERPROFILE stay set so the HOME guard does not fire.
    fs.mkdirSync(path.join(scanRoot, 'Block', 'goose'), { recursive: true });
    process.chdir(scanRoot);
    delete process.env.APPDATA;
    process.env.USERPROFILE = scanRoot;
    delete process.env.HOME;

    const restore = stubPlatform('win32');
    try {
      vi.resetModules();
      const mod = await import('../session-scanner.js');
      expect(mod.detectProviders()).not.toContain('goose');
    } finally {
      restore();
      vi.resetModules();
    }
  });
});
