import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectSiblings, mapWithConcurrency, readJsonlHistory } from '../session-scanner.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-ss-'));
});

afterEach(() => {
  // maxRetries: Windows can transiently ENOTEMPTY/EBUSY the rmdir while a
  // just-closed read stream still holds the directory (observed on the CI
  // windows-latest runners; the failure attributes to whichever test's
  // cleanup hits the race).
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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

  it('keeps the first entry when the file starts with a UTF-8 BOM', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    fs.writeFileSync(
      file,
      '\u{FEFF}' +
        [
          JSON.stringify({ display: 'first', project: '/p' }),
          JSON.stringify({ display: 'second', project: '/p' }),
        ].join('\n') +
        '\n',
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

  it('resolves to [] instead of rejecting when the stream errors at open', async () => {
    // A directory passes the existsSync guard but createReadStream fails with
    // EISDIR — same shape as history.jsonl vanishing between check and open.
    const entries = await readJsonlHistory({
      historyPath: tmpDir,
      provider: 'claude-code',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });

    expect(entries).toEqual([]);
  });
});

describe('readJsonlHistory timestamp and session fields', () => {
  it('maps the real Codex CLI shape {session_id, ts (seconds), text}', async () => {
    // codex-rs `message-history` writes exactly these three keys; `ts` is
    // unix SECONDS, normalized to the epoch-ms every session check compares.
    const file = path.join(tmpDir, 'history.jsonl');
    writeJsonl(file, [{ session_id: 'c-1', ts: 1_700_000_000, text: 'npm test' }]);

    const entries = await readJsonlHistory({
      historyPath: file,
      provider: 'codex-cli',
      displayFields: ['text'],
      projectFields: [],
      requireProject: false,
      sessionFields: ['session_id'],
      timestampFields: ['ts'],
      timestampUnit: 's',
    });

    expect(entries).toEqual([
      {
        display: 'npm test',
        timestamp: 1_700_000_000_000,
        project: '',
        sessionId: 'c-1',
        provider: 'codex-cli',
      },
    ]);
  });
});

describe('readJsonlHistory mid-stream read errors (mocked fs)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('returns the entries accumulated before the stream errored', async () => {
    const file = path.join(tmpDir, 'history.jsonl');
    fs.writeFileSync(file, ''); // satisfies the real existsSync guard path

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const { Readable } = await import('node:stream');
      return {
        ...actual,
        // One good line, then a locked-file error (EBUSY) mid-stream.
        createReadStream: () => {
          let calls = 0;
          return new Readable({
            read() {
              calls++;
              if (calls === 1) {
                this.push(`${JSON.stringify({ display: 'kept', project: '/p' })}\n`);
              } else {
                this.destroy(
                  Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }),
                );
              }
            },
          });
        },
      };
    });

    const mod = await import('../session-scanner.js');
    const entries = await mod.readJsonlHistory({
      historyPath: file,
      provider: 'claude-code',
      displayFields: ['display'],
      projectFields: ['project'],
      requireProject: true,
    });

    expect(entries.map((e) => e.display)).toEqual(['kept']);
  });
});

describe('mapWithConcurrency', () => {
  it('never exceeds the limit and preserves input order', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 23 }, (_, i) => i);

    const results = await mapWithConcurrency(items, 4, async (i) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return i * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(maxInFlight).toBeGreaterThan(1); // actually ran in parallel
    expect(results).toEqual(items.map((i) => i * 2));
  });

  it('handles empty input', async () => {
    expect(await mapWithConcurrency([], 8, async (x: number) => x)).toEqual([]);
  });
});

describe('detectSiblings >50-candidate branch', () => {
  it('returns every non-git sibling without dropping any', async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-sib-'));
    try {
      const projectRoot = path.join(parent, 'me');
      fs.mkdirSync(projectRoot);
      fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}');
      for (let i = 0; i < 55; i++) {
        const d = path.join(parent, `proj-${String(i).padStart(2, '0')}`);
        fs.mkdirSync(d);
        fs.writeFileSync(path.join(d, 'package.json'), '{}');
      }

      const siblings = await detectSiblings(projectRoot);

      expect(siblings).toHaveLength(55);
      expect(siblings.every((s) => !s.gitOrg)).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('home resolution OS fallback', () => {
  let prevHome: string | undefined;
  let prevUserProfile: string | undefined;
  let prevConfigDir: string | undefined;
  let prevCodexHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevUserProfile = process.env.USERPROFILE;
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    prevCodexHome = process.env.CODEX_HOME;
    // An ambient CLAUDE_CONFIG_DIR (Claude Code itself may export one) would
    // satisfy claude-code detection on its own and make these cases vacuous.
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-home-'));
  });

  afterEach(() => {
    vi.doUnmock('node:os');
    vi.resetModules();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  it('detects claude-code from CLAUDE_CONFIG_DIR when ~/.claude is absent', async () => {
    const configDir = path.join(fakeHome, 'custom-claude');
    fs.mkdirSync(configDir, { recursive: true });
    process.env.HOME = path.join(fakeHome, 'no-claude-here');
    process.env.USERPROFILE = path.join(fakeHome, 'no-claude-here');
    process.env.CLAUDE_CONFIG_DIR = configDir;

    const mod = await import('../session-scanner.js');
    expect(mod.detectProviders()).toContain('claude-code');
  });

  it('re-resolves home on every call instead of caching it at module load', async () => {
    const mod = await import('../session-scanner.js');
    const first = path.join(fakeHome, 'first');
    process.env.HOME = first;
    process.env.USERPROFILE = first;
    expect(mod.detectProviders()).not.toContain('claude-code');

    const second = path.join(fakeHome, 'second');
    fs.mkdirSync(path.join(second, '.claude'), { recursive: true });
    process.env.HOME = second;
    process.env.USERPROFILE = second;
    expect(mod.detectProviders()).toContain('claude-code');
  });

  it('falls back to os.homedir() when HOME and USERPROFILE are unset', async () => {
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    delete process.env.HOME;
    delete process.env.USERPROFILE;

    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => fakeHome };
    });

    const mod = await import('../session-scanner.js');
    expect(mod.detectProviders()).toContain('claude-code');
  });

  it('prefers HOME over os.homedir() when both resolve', async () => {
    // .claude exists only under the env home — detection proves env-first.
    const envHome = path.join(fakeHome, 'env-home');
    fs.mkdirSync(path.join(envHome, '.claude'), { recursive: true });
    process.env.HOME = envHome;
    delete process.env.USERPROFILE;

    vi.resetModules();
    vi.doMock('node:os', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:os')>();
      return { ...actual, homedir: () => path.join(fakeHome, 'os-home-without-claude') };
    });

    const mod = await import('../session-scanner.js');
    expect(mod.detectProviders()).toContain('claude-code');
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

describe('scanSessionData needs', () => {
  const KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('skips the history, memories and siblings a caller says it does not need', async () => {
    const home = path.join(tmpDir, 'home');
    fs.mkdirSync(path.join(home, '.claude', 'projects', 'p', 'memory'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude', 'history.jsonl'),
      `${JSON.stringify({ display: 'npm test', project: '/p', timestamp: 1 })}\n`,
    );
    fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 'memory', 'm.md'), 'memory body');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
    const project = path.join(tmpDir, 'parent', 'me');
    fs.mkdirSync(project, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'parent', 'sib'));
    fs.writeFileSync(path.join(tmpDir, 'parent', 'sib', 'package.json'), '{}');

    const { scanSessionData } = await import('../session-scanner.js');
    const full = await scanSessionData(project);
    expect(full.history).toHaveLength(1);
    expect(full.memories).toHaveLength(1);
    expect(full.siblings).toHaveLength(1);

    const none = await scanSessionData(project, {
      history: false,
      memories: false,
      siblings: false,
    });
    expect(none.history).toEqual([]);
    expect(none.memories).toEqual([]);
    expect(none.siblings).toEqual([]);
  });
});
