import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearTranscriptCache } from '../../../transcript.js';
import type { HistoryEntry, SessionContext } from '../../../types.js';
import { checkSharedTempPath } from '../shared-temp-path.js';

// The check also reads the project's transcripts. Point every home variable at
// an empty temp dir so no case reads a real ~/.claude/projects corpus.
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'] as const;
let savedEnv: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  home = mkdtempSync(join(tmpdir(), 'ctxlint-stp-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  clearTranscriptCache();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  clearTranscriptCache();
  rmSync(home, { recursive: true, force: true });
});

let clock = 0;
function cmd(display: string, project = '/repo/a'): HistoryEntry {
  return {
    display,
    timestamp: ++clock,
    project,
    sessionId: 's1',
    provider: 'claude-code',
  };
}

function ctx(history: HistoryEntry[]): SessionContext {
  return {
    history,
    memories: [],
    siblings: [],
    currentProject: '/repo/a',
    providers: ['claude-code'],
  };
}

describe('session/shared-temp-path', () => {
  it('flags the write-then-restore pair that caused the real incident', async () => {
    const issues = await checkSharedTempPath(
      ctx([
        cmd(`node -e 'fs.writeFileSync("/tmp/pkg.bak", fs.readFileSync("package.json"))'`),
        cmd('npm pack --dry-run'),
        cmd('cp /tmp/pkg.bak package.json'),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('session-shared-temp-path/shared-temp-path');
    expect(issues[0].message).toContain('/tmp/pkg.bak');
    // The detail must name BOTH sides -- the pair is the finding -- by verb
    // and path only: the rest of a command line can carry anything.
    expect(issues[0].detail).toContain('writeFileSync /tmp/pkg.bak');
    expect(issues[0].detail).toContain('cp /tmp/pkg.bak');
    expect(issues[0].detail).not.toContain('package.json');
  });

  it('echoes only the verb and path, never the rest of the command', async () => {
    const issues = await checkSharedTempPath(
      ctx([
        cmd('curl -H "Authorization: Bearer sk-secret" https://x -o /tmp/resp.json'),
        cmd('cat /tmp/resp.json'),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).not.toContain('sk-secret');
    expect(issues[0].detail).toContain('curl -o /tmp/resp.json');
  });

  it('ignores history typed in another project', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('cp a /tmp/x.bak', '/repo/b'), cmd('cp /tmp/x.bak b', '/repo/b')]),
    );
    expect(issues).toHaveLength(0);
  });

  it.runIf(process.platform === 'win32')(
    'matches history whose project differs only in drive-letter case (win32)',
    async () => {
      const issues = await checkSharedTempPath({
        ...ctx([cmd('cp a /tmp/x.bak', 'c:\\repo\\a'), cmd('cp /tmp/x.bak b', 'c:\\repo\\a')]),
        currentProject: 'C:\\repo\\a',
      });
      expect(issues).toHaveLength(1);
    },
  );

  it('does not flag paths under a per-session scratch directory', async () => {
    const scratch =
      '/tmp/claude/83003bca346503b0/c9ee8590-f33a-44a7-89bb-67bea27d2e6f/scratchpad/pkg.bak';
    const issues = await checkSharedTempPath(
      ctx([cmd(`cp package.json ${scratch}`), cmd(`cp ${scratch} package.json`)]),
    );
    expect(issues).toHaveLength(0);
  });

  it('does not flag a path carrying a session uuid', async () => {
    const p = '/tmp/run-c9ee8590-f33a-44a7-89bb-67bea27d2e6f/out.txt';
    const issues = await checkSharedTempPath(ctx([cmd(`echo x > ${p}`), cmd(`cat ${p}`)]));
    expect(issues).toHaveLength(0);
  });

  it('recognizes tail, head, grep, diff and interpreter reads', async () => {
    for (const read of [
      'tail -n 20 /tmp/log.txt',
      'head -5 /tmp/log.txt',
      'grep -n error /tmp/log.txt',
      'diff /tmp/log.txt expected.txt',
      'node /tmp/log.txt',
      'bash /tmp/log.txt',
      'python3 /tmp/log.txt',
    ]) {
      const issues = await checkSharedTempPath(ctx([cmd('npm test > /tmp/log.txt'), cmd(read)]));
      expect(issues, read).toHaveLength(1);
    }
  });

  it('strips a trailing ; or ) from a path token', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('(npm test > /tmp/out.log;)'), cmd('cat /tmp/out.log)')]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"/tmp/out.log"');
  });

  it('treats absolute Windows temp paths and $TEMP as shared roots', async () => {
    for (const [w, r] of [
      [
        'copy a C:\\Users\\me\\AppData\\Local\\Temp\\pkg.bak',
        'type C:\\Users\\me\\AppData\\Local\\Temp\\pkg.bak',
      ],
      ['cp a $TEMP/pkg.bak', 'cp $TEMP/pkg.bak a'],
      ['cp a /c/Users/me/AppData/Local/Temp/pkg.bak', 'cat /c/Users/me/AppData/Local/Temp/pkg.bak'],
    ]) {
      const issues = await checkSharedTempPath(ctx([cmd(w), cmd(r)]));
      expect(issues, w).toHaveLength(1);
    }
  });

  it('flags a shell redirect written then read back', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('git diff > /tmp/patch.diff'), cmd('git apply < /tmp/patch.diff')]),
    );
    expect(issues).toHaveLength(1);
  });

  it('does not flag mktemp output -- that is the correct form', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('T=$(mktemp) && cp package.json "$T"'), cmd('cp "$T" package.json')]),
    );
    expect(issues).toHaveLength(0);
  });

  it('does not flag a path carrying a per-run component', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('cp package.json /tmp/pkg-$$.bak'), cmd('cp /tmp/pkg-$$.bak package.json')]),
    );
    expect(issues).toHaveLength(0);
  });

  it('does not flag a write that is never read back', async () => {
    // A scratch file nobody restores from cannot be clobbered into the workspace.
    const issues = await checkSharedTempPath(
      ctx([cmd('npm test > /tmp/test.log'), cmd('echo done')]),
    );
    expect(issues).toHaveLength(0);
  });

  it('does not flag a read with no preceding write', async () => {
    const issues = await checkSharedTempPath(ctx([cmd('cat /tmp/provided-by-someone-else.txt')]));
    expect(issues).toHaveLength(0);
  });

  it('requires the write to PRECEDE the read, not merely co-occur', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('cp /tmp/x.bak package.json'), cmd('cp package.json /tmp/x.bak')]),
    );
    expect(issues).toHaveLength(0);
  });

  it('reports a given path once, not once per later read', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('cp a /tmp/x.bak'), cmd('cp /tmp/x.bak b'), cmd('cp /tmp/x.bak c')]),
    );
    expect(issues).toHaveLength(1);
  });

  it('ignores a bare temp root -- a directory is not a clobberable file', async () => {
    const issues = await checkSharedTempPath(ctx([cmd('cp a /tmp/'), cmd('cp /tmp/ b')]));
    expect(issues).toHaveLength(0);
  });

  it('covers the Windows %TEMP% form', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('copy pkg.json %TEMP%\\pkg.bak'), cmd('cp %TEMP%\\pkg.bak pkg.json')]),
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});
