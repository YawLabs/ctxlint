import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkHookCoverage,
  isMsysFlag,
  stripMatcherWildcard,
  translateMsysDrivePath,
} from '../hook-coverage.js';

let tmpDir: string;
// Isolated home dir so the check never reads the real user-global
// ~/.claude/settings.json (which would pollute exact-count assertions).
let homeDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-hook-'));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-home-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

function writeSettings(obj: unknown, file = 'settings.json'): void {
  const dir = path.join(tmpDir, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 2));
}

function writeHookScript(rel: string): string {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, '#!/bin/sh\necho hi\n');
  return abs;
}

describe('hook-coverage/dead-hook', () => {
  it('flags a PreToolUse hook pointing at a missing script', async () => {
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash ./.claude/hooks/gate.sh' }] }],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('hook-coverage/dead-hook');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].message).toContain('gate.sh');
    expect(issues[0].message).toContain('PreToolUse hook');
  });

  it('does NOT flag a hook whose script exists on disk', async () => {
    writeHookScript('.claude/hooks/gate.sh');
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash ./.claude/hooks/gate.sh' }] }],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('resolves $CLAUDE_PROJECT_DIR and flags only when missing', async () => {
    writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/missing.js"' }],
          },
        ],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('missing.js');
  });

  it('does not flag inline tool matchers without a path (e.g. "npm login")', async () => {
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash(npm login)', hooks: [{ command: 'block npm login' }] }],
      },
      permissions: { deny: ['Bash(git push --force)'] },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('flags a permissions entry that references a missing script', async () => {
    writeSettings({
      permissions: { deny: ['Bash(./scripts/dead-gate.sh)'] },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('dead-gate.sh');
    expect(issues[0].message).toContain('permissions.deny');
  });

  it('skips a path with an unresolvable env var (cannot verify -> no false positive)', async () => {
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash "$SOME_CUSTOM_VAR/hook.sh"' }] }],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('resolves Windows-style %USERPROFILE% and does not flag an existing script', async () => {
    fs.mkdirSync(path.join(homeDir, '.claude', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(homeDir, '.claude', 'hooks', 'gate.ps1'), 'Write-Host hi');
    writeSettings({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ command: 'pwsh "%USERPROFILE%/.claude/hooks/gate.ps1"' }] },
        ],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('skips a path with an unresolvable %VAR% (cannot verify -> no false positive)', async () => {
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'pwsh "%CUSTOM_TOOLS%\\gate.ps1"' }] }],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('reports the correct line number for a project settings file', async () => {
    // command is on a known line of the pretty-printed JSON.
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash ./.claude/hooks/gate.sh' }] }],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    const raw = fs.readFileSync(path.join(tmpDir, '.claude', 'settings.json'), 'utf-8');
    const expectedLine = raw.split('\n').findIndex((l) => l.includes('"command"')) + 1;
    expect(issues[0].line).toBe(expectedLine);
  });

  it('also scans settings.local.json', async () => {
    writeSettings(
      {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: './.claude/hooks/local-gate.sh' }] }],
        },
      },
      'settings.local.json',
    );
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('local-gate.sh');
  });

  it('returns nothing when there is no .claude/settings.json', async () => {
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('does NOT scan the user-global ~/.claude/settings.json by default', async () => {
    // A dead hook in the user-global file must be ignored unless opted in.
    const userClaude = path.join(homeDir, '.claude');
    fs.mkdirSync(userClaude, { recursive: true });
    fs.writeFileSync(
      path.join(userClaude, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash ~/.claude/hooks/dead.sh' }] }],
        },
      }),
    );
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('scans the user-global ~/.claude/settings.json only when userGlobal is set', async () => {
    const userClaude = path.join(homeDir, '.claude');
    fs.mkdirSync(userClaude, { recursive: true });
    fs.writeFileSync(
      path.join(userClaude, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash ~/.claude/hooks/dead.sh' }] }],
        },
      }),
    );
    const issues = await checkHookCoverage(tmpDir, homeDir, { userGlobal: true });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('dead.sh');
    expect(issues[0].message).toContain('~/.claude/settings.json');
  });

  // --- Windows / MSYS false-positive regressions ---
  // Permission entries authored in Git Bash on Windows carry a trailing `*`
  // matcher wildcard, double-slash command flags (`//FI`, `//F`), and `/c/`
  // drive paths. Before the fix each of these was reported as a dead hook.

  it('does NOT flag a permissions entry whose script exists despite a trailing * wildcard', async () => {
    writeHookScript('scripts/gate.sh');
    writeSettings({ permissions: { allow: ['Bash(bash ./scripts/gate.sh*)'] } });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('still flags a genuinely missing script even with a trailing * wildcard', async () => {
    writeSettings({ permissions: { allow: ['Bash(bash ./scripts/dead.sh*)'] } });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('dead.sh');
  });

  it('does not flag MSYS //FLAG tokens (Windows command flags, not paths)', async () => {
    writeSettings({
      permissions: { allow: ['Bash(tasklist //FI*)', 'Bash(taskkill //F*)'] },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('does not flag a path with a mid-token glob (unstat-able, not a single file)', async () => {
    // The `*` here is not the trailing permission wildcard -- it is a glob
    // inside the path, so there is no single file to check for existence.
    writeSettings({ permissions: { allow: ['Bash(cat ./logs/*.json)'] } });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')(
    'resolves an MSYS /c/ drive path and does not flag an existing script (win32)',
    async () => {
      const abs = writeHookScript('scripts/smoke.sh');
      // Convert the real Win32 path (C:\...\smoke.sh) to its Git Bash form
      // (/c/.../smoke.sh) and append the permission matcher wildcard.
      const msys = `/${abs[0].toLowerCase()}${abs.slice(2).replace(/\\/g, '/')}`;
      writeSettings({ permissions: { allow: [`Bash(bash ${msys}*)`] } });
      const issues = await checkHookCoverage(tmpDir, homeDir);
      expect(issues).toEqual([]);
    },
  );
});

describe('hook-coverage helpers', () => {
  it('stripMatcherWildcard removes a trailing * or :* matcher wildcard', () => {
    expect(stripMatcherWildcard('/path/gate.sh*')).toBe('/path/gate.sh');
    expect(stripMatcherWildcard('gate.js:*')).toBe('gate.js');
    expect(stripMatcherWildcard('//FI*')).toBe('//FI');
    // No wildcard -> unchanged.
    expect(stripMatcherWildcard('/path/gate.sh')).toBe('/path/gate.sh');
  });

  it('isMsysFlag recognizes Git Bash //FLAG tokens but not UNC or drive paths', () => {
    expect(isMsysFlag('//FI')).toBe(true);
    expect(isMsysFlag('//F')).toBe(true);
    // Real UNC path (later separator) and MSYS drive path are NOT flags.
    expect(isMsysFlag('//host/share')).toBe(false);
    expect(isMsysFlag('/c/Users/x')).toBe(false);
    expect(isMsysFlag('./gate.sh')).toBe(false);
  });

  it('translateMsysDrivePath rewrites /c/ to c:/ only on win32', () => {
    expect(translateMsysDrivePath('/c/Users/x/gate.sh', 'win32')).toBe('c:/Users/x/gate.sh');
    expect(translateMsysDrivePath('/d/repo/gate.sh', 'win32')).toBe('d:/repo/gate.sh');
    // POSIX: /c/... is a genuine absolute path, never rewritten.
    expect(translateMsysDrivePath('/c/Users/x/gate.sh', 'linux')).toBe('/c/Users/x/gate.sh');
    // Multi-letter first segment is not a drive -- unchanged on win32.
    expect(translateMsysDrivePath('/Users/x/gate.sh', 'win32')).toBe('/Users/x/gate.sh');
  });
});
