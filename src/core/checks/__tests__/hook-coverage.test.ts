import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  checkHookCoverage,
  isMsysFlag,
  resolveRulePath,
  stripMatcherWildcard,
  translateMsysDrivePath,
} from '../hook-coverage.js';
import { hookShellWords } from '../shell-words.js';

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

  it('flags a permissions.allow entry that references a missing script', async () => {
    writeSettings({
      permissions: { allow: ['Bash(./scripts/dead-gate.sh)'] },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('dead-gate.sh');
    expect(issues[0].message).toContain('permissions.allow');
  });

  it('never reports deny/ask entries: a guard against a missing path is working', async () => {
    // The canonical secrets guard, in a repo that has no .env or secrets/ yet.
    writeSettings({
      permissions: {
        deny: ['Read(./.env)', 'Read(./secrets/**)', 'Bash(./scripts/dead-gate.sh)'],
        ask: ['Bash(bash ./scripts/also-gone.sh)'],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
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
    // Outside the project: no file to route it to, so it stays in (project).
    expect(issues[0].file).toBeUndefined();
  });

  describe('with no home injected (production resolution)', () => {
    const KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'] as const;
    let saved: Record<string, string | undefined>;
    beforeEach(() => {
      saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
      process.env.HOME = homeDir;
      process.env.USERPROFILE = homeDir;
    });
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('reads the user-global settings from CLAUDE_CONFIG_DIR, and expands $CLAUDE_CONFIG_DIR to it', async () => {
      const configDir = path.join(homeDir, 'custom-claude');
      fs.mkdirSync(path.join(configDir, 'hooks'), { recursive: true });
      fs.writeFileSync(path.join(configDir, 'hooks', 'live.sh'), '#!/bin/sh\n');
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({
          hooks: {
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [
                  { command: 'bash "$CLAUDE_CONFIG_DIR/hooks/live.sh"' },
                  { command: 'bash "$CLAUDE_CONFIG_DIR/hooks/dead.sh"' },
                ],
              },
            ],
          },
        }),
      );
      process.env.CLAUDE_CONFIG_DIR = configDir;
      const issues = await checkHookCoverage(tmpDir, undefined, { userGlobal: true });
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('dead.sh');
      expect(issues[0].message).toContain(
        path.join(configDir, 'settings.json').replace(/\\/g, '/'),
      );
    });

    it('resolves ~ from the home Claude Code uses', async () => {
      delete process.env.CLAUDE_CONFIG_DIR;
      fs.mkdirSync(path.join(homeDir, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(homeDir, 'bin', 'gate.sh'), '#!/bin/sh\n');
      writeSettings({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash ~/bin/gate.sh' }] }] },
      });
      expect(await checkHookCoverage(tmpDir)).toEqual([]);
    });
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

  it.skipIf(process.platform !== 'win32')(
    'resolves an MSYS /c/ DIRECTORY target in a cd entry (win32)',
    async () => {
      // Same shape as the observed `Bash(cd /c/Users/<user>/<repo>*)` entry:
      // the target is a directory, not a script, and it exists. The existence
      // check must accept directories after the drive-path translation.
      const absDir = path.join(tmpDir, 'sub', 'project');
      fs.mkdirSync(absDir, { recursive: true });
      const msysDir = `/${absDir[0].toLowerCase()}${absDir.slice(2).replace(/\\/g, '/')}`;
      writeSettings({ permissions: { allow: [`Bash(cd ${msysDir}*)`] } });
      const issues = await checkHookCoverage(tmpDir, homeDir);
      expect(issues).toEqual([]);
    },
  );

  it.skipIf(process.platform !== 'win32')(
    'still flags a genuinely missing MSYS /c/ directory target (win32)',
    async () => {
      // Control for the test above: the same cd-entry shape pointing at a
      // directory that does NOT exist must keep flagging.
      const absDir = path.join(tmpDir, 'no', 'such', 'dir');
      const msysDir = `/${absDir[0].toLowerCase()}${absDir.slice(2).replace(/\\/g, '/')}`;
      writeSettings({ permissions: { allow: [`Bash(cd ${msysDir}*)`] } });
      const issues = await checkHookCoverage(tmpDir, homeDir);
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('does not exist on disk');
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

  it('translateMsysDrivePath rewrites a DOUBLED leading slash too (//c/ -> c:/)', () => {
    // Git Bash renders a drive path this way to suppress MSYS translation and
    // Claude Code writes the form into settings verbatim. Observed in a real
    // permissions.allow entry: untranslated it reads as a UNC path, fails the
    // existence check, and reports a live directory as a dead gate.
    expect(translateMsysDrivePath('//c/Users/x/gate.sh', 'win32')).toBe('c:/Users/x/gate.sh');
    expect(translateMsysDrivePath('//d/repo/gate.sh', 'win32')).toBe('d:/repo/gate.sh');
    // POSIX untouched in the doubled form too.
    expect(translateMsysDrivePath('//c/Users/x/gate.sh', 'linux')).toBe('//c/Users/x/gate.sh');
    // A genuine UNC path has a multi-character host and must survive intact.
    expect(translateMsysDrivePath('//host/share/gate.sh', 'win32')).toBe('//host/share/gate.sh');
    expect(translateMsysDrivePath('//server/c/gate.sh', 'win32')).toBe('//server/c/gate.sh');
  });
});

describe('hook-coverage/dead-hook path-form vs missing target', () => {
  it.skipIf(process.platform !== 'win32')(
    'resolves a DOUBLED-slash MSYS drive path in a Bash rule without flagging it (win32)',
    async () => {
      const abs = writeHookScript('scripts/smoke.sh');
      const msys = `//${abs[0].toLowerCase()}${abs.slice(2).replace(/\\/g, '/')}`;
      writeSettings({ permissions: { allow: [`Bash(bash ${msys}*)`] } });
      const issues = await checkHookCoverage(tmpDir, homeDir);
      expect(issues).toEqual([]);
    },
  );

  it('resolves a `Read(//<absolute>/dir/**)` rule naming an existing directory', async () => {
    // Regression for the false positive this rule produced on a real repo:
    // `Read(//c/Users/.../dir/**)` named an existing directory and was
    // reported as "does not exist on disk". `//` is the documented absolute
    // prefix; on Windows the path after it is the POSIX-normalized drive form.
    const absDir = path.join(tmpDir, 'shared', 'dir');
    fs.mkdirSync(absDir, { recursive: true });
    const rule =
      process.platform === 'win32'
        ? `//${absDir[0].toLowerCase()}${absDir.slice(2).replace(/\\/g, '/')}/**`
        : `/${absDir}/**`;
    writeSettings({ permissions: { allow: [`Read(${rule})`] } });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toEqual([]);
  });

  it('says the path FORM is wrong when the target exists under another spelling', async () => {
    // A leading-slash typo on a repo-relative path: the script is present, so
    // the remedy is to fix the spelling, NOT to delete the entry.
    writeHookScript('.claude/hooks/gate.sh');
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash /.claude/hooks/gate.sh' }] }],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('does not resolve');
    expect(issues[0].message).toContain('the path form is wrong');
    expect(issues[0].message).not.toContain('does not exist on disk');
    expect(issues[0].suggestion).toContain('Do NOT delete it');
  });

  it('still reports a genuinely absent target as missing on disk', async () => {
    // No variant of this path exists -- the original wording must stand.
    writeSettings({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'bash ./.claude/hooks/absent.sh' }] }],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('does not exist on disk');
    expect(issues[0].message).not.toContain('path form');
  });
});

describe('hook-coverage/dead-hook false positives on correct settings', () => {
  it('joins a quoted $CLAUDE_PROJECT_DIR with the unquoted rest of the word', async () => {
    // The form Claude Code's hook docs recommend. Splitting it at the quote
    // produced `$CLAUDE_PROJECT_DIR` plus a bogus absolute `/.claude/...`.
    writeHookScript('.claude/hooks/check-style.sh');
    writeSettings({
      hooks: {
        PostToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check-style.sh' }],
          },
        ],
      },
    });
    expect(await checkHookCoverage(tmpDir, homeDir)).toEqual([]);
  });

  it('still flags the joined word when its script is missing', async () => {
    writeSettings({
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/gone.sh' }] },
        ],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/gone.sh');
    expect(issues[0].message).toContain('does not exist on disk');
  });

  it('reads `Read(/docs/**)` as project-root-relative, not filesystem-absolute', async () => {
    fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeSettings({ permissions: { allow: ['Read(/docs/**)', 'Edit(./docs/**)'] } });
    expect(await checkHookCoverage(tmpDir, homeDir)).toEqual([]);
  });

  it('flags a project-relative Read rule whose directory is missing', async () => {
    writeSettings({ permissions: { allow: ['Read(/no-such-dir/**)'] } });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('/no-such-dir/**');
    expect(issues[0].message).toContain('matches nothing');
  });

  it('anchors a single-slash rule in the user-global file at ~/.claude', async () => {
    fs.mkdirSync(path.join(homeDir, '.claude', 'notes'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Read(/notes/**)', 'Read(~/.claude/notes/**)'] } }),
    );
    expect(await checkHookCoverage(tmpDir, homeDir, { userGlobal: true })).toEqual([]);
  });

  it('skips a URL argument', async () => {
    writeSettings({
      permissions: { allow: ['Bash(curl -fsSL https://get.example.org/install.sh)'] },
    });
    expect(await checkHookCoverage(tmpDir, homeDir)).toEqual([]);
  });

  it('treats a single-slash /X word as a flag on win32 (cmd /c dir)', async () => {
    writeSettings({ permissions: { allow: ['Bash(cmd /c dir)', 'Bash(taskkill /F /IM x.exe)'] } });
    expect(await checkHookCoverage(tmpDir, homeDir, {}, 'win32')).toEqual([]);
  });

  it('tests the value of --flag=value and VAR=value words', async () => {
    writeHookScript('eslint.config.js');
    writeSettings({
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ command: 'npx eslint --config=./eslint.config.js .' }] },
        ],
      },
    });
    expect(await checkHookCoverage(tmpDir, homeDir)).toEqual([]);

    writeSettings({
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ command: 'HOOK=./.claude/hooks/nope.sh run-hook' }] },
        ],
      },
    });
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('"./.claude/hooks/nope.sh"');
  });

  it('does not stat redirection targets', async () => {
    writeHookScript('.claude/hooks/gate.sh');
    writeSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ command: 'bash ./.claude/hooks/gate.sh > ./logs/gate.log 2>&1' }],
          },
        ],
      },
    });
    expect(await checkHookCoverage(tmpDir, homeDir)).toEqual([]);
  });
});

describe('hook-coverage/dead-hook messages', () => {
  it('names the settings file, so settings.local.json findings are distinguishable', async () => {
    writeSettings(
      { permissions: { allow: ['Bash(./scripts/local-gone.sh)'] } },
      'settings.local.json',
    );
    const issues = await checkHookCoverage(tmpDir, homeDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('(in .claude/settings.local.json)');
    // The structured twin the audit routes by (it no longer parses messages).
    expect(issues[0].file).toBe('.claude/settings.local.json');
  });

  it('words the suggestion for the source: no "PreToolUse hook" on a permissions entry', async () => {
    writeSettings({ permissions: { allow: ['Bash(./scripts/gone.sh)'] } });
    const [perm] = await checkHookCoverage(tmpDir, homeDir);
    expect(perm.suggestion).not.toContain('PreToolUse');
    expect(perm.suggestion).toContain('allow rule');

    writeSettings({
      hooks: { Stop: [{ hooks: [{ command: 'bash ./.claude/hooks/stop-gone.sh' }] }] },
    });
    const [hook] = await checkHookCoverage(tmpDir, homeDir);
    expect(hook.message).toContain('Stop hook');
    expect(hook.suggestion).toContain('A Stop hook pointing at a missing script');
  });
});

describe('hook-coverage unparseable settings', () => {
  it('warns once and skips a malformed settings file instead of checking a partial tree', async () => {
    const dir = path.join(tmpDir, '.claude');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      '{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "command": "bash ./.claude/hooks/gone.sh" }] }] }, oops }',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await checkHookCoverage(tmpDir, homeDir)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('.claude/settings.json');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('hook-coverage helpers (pure, any OS)', () => {
  it('hookShellWords joins adjacent quoted and unquoted pieces', () => {
    expect(hookShellWords(`"$A"/b/c.sh --x 'y z'`).map((w) => w.text)).toEqual([
      '$A/b/c.sh',
      '--x',
      'y z',
    ]);
  });

  it('hookShellWords marks redirection targets and drops fd numbers', () => {
    const words = hookShellWords('run ./a.sh > out.log 2>&1 && next');
    expect(words.map((w) => [w.text, w.redirectTarget])).toEqual([
      ['run', false],
      ['./a.sh', false],
      ['out.log', true],
      ['1', true],
      ['next', false],
    ]);
  });

  it('hookShellWords keeps unquoted Windows backslashes', () => {
    expect(hookShellWords('pwsh C:\\hooks\\gate.ps1').map((w) => w.text)).toEqual([
      'pwsh',
      'C:\\hooks\\gate.ps1',
    ]);
  });

  it('resolveRulePath follows the documented prefix syntax', () => {
    const root = path.resolve('/proj');
    const home = path.resolve('/home/u');
    expect(resolveRulePath('/docs/**', root, home, false, 'linux')).toBe(path.join(root, 'docs'));
    expect(resolveRulePath('/docs/**', root, home, true, 'linux')).toBe(
      path.join(home, '.claude', 'docs'),
    );
    // A moved config dir (CLAUDE_CONFIG_DIR) anchors the user-global file.
    const cfg = path.resolve('/cfg/claude');
    expect(resolveRulePath('/docs/**', root, home, true, 'linux', cfg)).toBe(
      path.join(cfg, 'docs'),
    );
    expect(resolveRulePath('~/notes/*', root, home, false, 'linux')).toBe(path.join(home, 'notes'));
    expect(resolveRulePath('./src/**', root, home, false, 'linux')).toBe(path.join(root, 'src'));
    // `//` is filesystem-absolute; on win32 the drive form is translated.
    expect(resolveRulePath('//c/Users/x/dir/**', root, home, false, 'win32')).toBe(
      'c:/Users/x/dir',
    );
    // Nothing single to stat: inner globs, negations, bare names.
    expect(resolveRulePath('src/**/*.ts', root, home, false, 'linux')).toBeNull();
    expect(resolveRulePath('!./public/**', root, home, false, 'linux')).toBeNull();
    expect(resolveRulePath('*.env', root, home, false, 'linux')).toBeNull();
  });
});
