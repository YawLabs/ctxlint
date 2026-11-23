import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const releaseSh = readFileSync(fileURLToPath(new URL('../../release.sh', import.meta.url)), 'utf8');

describe('release.sh MCP Registry calls', () => {
  // mcp-publisher waits for the registry's answer with no limit of its own, so
  // release.sh runs each call to it -- every login and every publish attempt --
  // through mcp_bounded, its time limit. A call added or edited without it
  // would hang the release on a registry that never answers.
  it('runs every mcp-publisher login and publish through mcp_bounded', () => {
    const calls = releaseSh
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && /"\$MP" (login|publish)\b/.test(line));
    expect(calls.filter((line) => line.includes('"$MP" login')).length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((line) => line.includes('"$MP" publish')).length).toBeGreaterThanOrEqual(1);
    for (const line of calls) {
      expect(line, 'release.sh runs mcp-publisher without its time limit').toMatch(
        /mcp_bounded "\$MP" (login|publish)\b/,
      );
    }
  });

  // A first login the limit stopped is the registry not answering, not a bad
  // token: mcp_login_fail says so, where a bare fail would blame the token.
  it('fails a first login through mcp_login_fail', () => {
    expect(releaseSh).toMatch(/^mcp_login_fail\(\) \{$/m);
    expect(releaseSh).toMatch(/mcp_login_fail "mcp-publisher (OIDC )?login failed/);
    expect(releaseSh).not.toMatch(/\bfail "mcp-publisher (OIDC )?login failed/);
    // The registry decides the namespace grant at login but refuses only at
    // publish, so a login failure that names a token scope blames something
    // that cannot cause it.
    expect(releaseSh).not.toMatch(/mcp_login_fail "[^"]*read:org/);
  });

  // A proxy's refusal is matched right after the quoted URL, so a reason
  // phrase with a colon counts and a server's bytes echoed inside Go's quotes
  // do not; and a publish refused with a 403 gets its note, from a flag taken
  // before the publish log is removed.
  it("matches a proxy's refusal after the URL, and notes a 403 on publish", () => {
    expect(releaseSh).toContain('error sending request: [A-Z][a-z]+ "[^"]*": (');
    expect(releaseSh).toMatch(/MCP_REFUSED_NAMESPACE=true; fi\n\s*rm -f "\$MCP_PUBLISH_LOG"/);
    expect(releaseSh).toContain(
      'A 403 on publish is the registry refusing the io.github.YawLabs namespace',
    );
  });

  // The first mcp_bounded call sets the limit up; a flag inherited from the
  // environment must not stand in for that.
  it('sets the time limit up itself, whatever the environment carries', () => {
    expect(releaseSh).toMatch(/^MCP_TIMEOUT_READY=""$/m);
  });
});

// ---------------------------------------------------------------------------
// Pre-flight, push and step-boundary behaviour. release.sh publishes to npm, so
// no test runs it whole: these read its text, and the helpers that carry real
// logic are cut out and executed on their own under bash.
// ---------------------------------------------------------------------------

/** The text from `start` up to `end`, loudly. */
function between(start: string, end: string): string {
  const from = releaseSh.indexOf(start);
  const to = releaseSh.indexOf(end, from + start.length);
  if (from === -1 || to === -1) throw new Error(`release.sh no longer has ${start} ... ${end}`);
  return releaseSh.slice(from, to);
}
/** Comment lines dropped, so prose cannot satisfy an assertion about code. */
const code = (text: string) =>
  text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');

const preflight = () => code(between('# ---- Pre-flight checks ----', 'step 1 "Lint'));
const stepBody = (n: number) => code(between(`step ${n} "`, `step ${n + 1} "`));

/**
 * Git for Windows' bash -- never C:\Windows\System32\bash.exe (WSL), which PATH
 * can find first -- and plain `bash` elsewhere. Null when there is none.
 */
function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    const root = path.resolve(exec, '..', '..', '..');
    for (const rel of ['usr/bin/bash.exe', 'bin/bash.exe']) {
      if (existsSync(path.join(root, rel))) return path.join(root, rel);
    }
  } catch {
    // No git, so no Git Bash.
  }
  return null;
}
const BASH = findBash();
// Each bash case spawns a handful of git and bash processes, which a loaded
// Windows box was measured taking past 60 s to start.
const BASH_TIMEOUT_MS = 180_000;

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A scratch git repo: one tagged commit, then one commit after the tag. */
function scratchRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ctxlint-release-sh-'));
  tmpDirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  writeFileSync(path.join(dir, 'package.json'), '{}\n');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
  writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'feat: add a');
  return dir;
}

/** Run `script` under bash in `cwd`, with release.sh's helpers defined. */
function runHelpers(cwd: string, script: string): string {
  const prelude = [
    'set -euo pipefail',
    'info() { echo "INFO $1"; }',
    'warn() { echo "WARN $1"; }',
    'fail() { echo "FAIL $1"; exit 1; }',
    'VERSION=0.2.0',
    between('# --- CHANGELOG promotion', '# --- end CHANGELOG helpers ---'),
    between('# ---- Release-written files ----', '# ---- end release-written files ----'),
  ].join('\n');
  return execFileSync(BASH as string, ['-c', `${prelude}\n${script}`], {
    cwd,
    encoding: 'utf8',
  });
}

describe('release.sh pre-flight', () => {
  it('requires main, fetches, and refuses a branch behind origin/main', () => {
    const pre = preflight();
    expect(pre).toMatch(/git rev-parse --abbrev-ref HEAD/);
    expect(pre).toMatch(/!= "main"/);
    expect(pre).toMatch(/git fetch[^\n]*origin/);
    expect(pre).toMatch(/HEAD\.\.origin\/main/);
  });

  it('checks every tool and login the later steps need, before step 1', () => {
    const pre = preflight();
    for (const tool of ['node', 'pnpm', 'npm', 'jq', 'gh', 'curl']) {
      expect(pre, tool).toMatch(new RegExp(`command -v ${tool}\\b`));
    }
    expect(pre).toMatch(/npm whoami/);
    expect(pre).toMatch(/gh auth status/);
  });

  it('has no CI mode: a version argument is required, whatever CI says', () => {
    expect(releaseSh).not.toMatch(/IS_CI|GITHUB_REF_NAME|--provenance|CI mode/);
    expect(releaseSh).not.toMatch(/\.github\/workflows\/release\.yml/);
  });

  it('checks the tree and asks for confirmation on a resume too', () => {
    const pre = preflight();
    expect(pre).not.toMatch(/RESUMING" != "true" \]/);
    expect(pre).toMatch(/dirty_outside_release_files/);
  });
});

describe.skipIf(!BASH)('release.sh dirty_outside_release_files', () => {
  it(
    'ignores the files the release writes and names anything else',
    () => {
      const dir = scratchRepo();
      writeFileSync(path.join(dir, 'package.json'), '{"version":"0.2.0"}\n');
      expect(runHelpers(dir, 'dirty_outside_release_files').trim()).toBe('');
      writeFileSync(path.join(dir, 'a.txt'), 'edited\n');
      writeFileSync(path.join(dir, 'new.txt'), 'new\n');
      const out = runHelpers(dir, 'dirty_outside_release_files');
      expect(out).toMatch(/a\.txt/);
      expect(out).toMatch(/new\.txt/);
      expect(out).not.toMatch(/package\.json/);
    },
    BASH_TIMEOUT_MS,
  );
});

describe.skipIf(!BASH)('release.sh CHANGELOG generation', () => {
  // A generated entry used to put "- subject" directly under "### Changed",
  // which prettier rewrites. The entry is written after step 3's
  // `prettier --check .`, so it was the NEXT release's test run that failed.
  it(
    'writes an entry from commit subjects that prettier accepts as is',
    async () => {
      const dir = scratchRepo();
      writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-01-01\n\n### Added\n\n- first\n',
      );
      runHelpers(dir, 'promote_changelog');
      const text = readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
      expect(text).toMatch(/## \[0\.2\.0\] - \d{4}-\d{2}-\d{2}\n\n### Changed\n\n- feat: add a\n/);
      const prettier = await import('prettier');
      expect(await prettier.check(text, { parser: 'markdown' }), text).toBe(true);
    },
    BASH_TIMEOUT_MS,
  );

  it(
    'prints the version section as the release notes',
    () => {
      const dir = scratchRepo();
      writeFileSync(
        path.join(dir, 'CHANGELOG.md'),
        '# Changelog\n\n## [0.2.0] - 2026-01-02\n\n### Fixed\n\n- a bug\n\n## [0.1.0] - 2026-01-01\n',
      );
      expect(runHelpers(dir, 'release_notes')).toBe('### Fixed\n\n- a bug\n');
    },
    BASH_TIMEOUT_MS,
  );
});

describe('release.sh steps', () => {
  it('formats server.json after jq rewrites it', () => {
    const sync = code(between('sync_version_files() {', '\n}\n'));
    expect(sync).toContain('jq ');
    expect(sync.indexOf('npx prettier --write server.json')).toBeGreaterThan(sync.indexOf('jq '));
  });

  it('re-reads the version at step 4 and prettier-checks what step 4 wrote', () => {
    const step4 = stepBody(4);
    expect(step4).toContain(`CURRENT_VERSION=$(node -p "require('./package.json').version")`);
    expect(step4.indexOf('npx prettier --check')).toBeGreaterThan(
      step4.indexOf('assert_changelog_promoted'),
    );
  });

  // A non-atomic `git push origin main --tags` lands the tag even when main is
  // rejected, and pushes every stray local tag along with it.
  it('pushes main and this one tag atomically', () => {
    expect(stepBody(5)).toContain('git push --atomic origin main "refs/tags/v${VERSION}"');
    expect(code(releaseSh)).not.toMatch(/push[^\n]*--tags|--follow-tags/);
  });

  // A resume after a pull or rebase has HEAD off the tag the earlier run made;
  // publishing from there puts commits on npm the tag does not contain.
  it('refuses an existing tag that does not point at HEAD, naming both SHAs', () => {
    const step5 = stepBody(5);
    const tagged = step5.slice(step5.indexOf('if git tag -l "v${VERSION}"'));
    expect(tagged).toContain('TAG_COMMIT=$(git rev-parse "v${VERSION}^{commit}")');
    expect(tagged).toContain('HEAD_COMMIT=$(git rev-parse HEAD)');
    expect(tagged).toMatch(
      /if \[ "\$TAG_COMMIT" != "\$HEAD_COMMIT" \]; then\n\s*fail "[^"]*\$TAG_COMMIT[^"]*\$HEAD_COMMIT/,
    );
    // Checked before anything is pushed.
    expect(tagged.indexOf('TAG_COMMIT')).toBeLessThan(tagged.indexOf('git push --atomic'));
  });

  it('does not tell a resume whose tag is already on origin to pull', () => {
    const pre = preflight();
    const behind = pre.slice(pre.indexOf('if [ "$BEHIND" != "0" ]'));
    const tagOnOrigin = behind.indexOf(
      'git ls-remote --exit-code --tags origin "refs/tags/v${VERSION}"',
    );
    expect(tagOnOrigin).toBeGreaterThan(-1);
    const resumeFail = /fail "([^"]*)"/.exec(behind.slice(tagOnOrigin));
    expect(resumeFail?.[1]).toMatch(/Do NOT pull/);
    expect(resumeFail?.[1]).not.toMatch(/-- pull/);
    // CURRENT_VERSION is known before the behind check needs it.
    expect(pre.indexOf('CURRENT_VERSION=$(node -p')).toBeLessThan(pre.indexOf('if [ "$BEHIND"'));
  });

  it('says what landed when origin cannot be read after the tag', () => {
    const step5 = stepBody(5);
    expect(step5).not.toMatch(/\$\(git ls-remote[^)]*2>\/dev\/null \| awk/);
    expect(step5).toMatch(/if ! ORIGIN_TAGS=\$\(git ls-remote/);
  });

  it('carries no dead branches', () => {
    expect(releaseSh).not.toMatch(/3221225477 \]/);
    expect(releaseSh).not.toMatch(/^\s*(npm|pnpm)\(\) \{/m);
    expect(releaseSh).not.toMatch(/changelog_update_links|PREV_TAG/);
  });

  it('does not call a stale oam floor current when one is allowed', () => {
    expect(stepBody(3)).toMatch(/grep -q '\^STALE:'/);
  });

  // The header, the failure messages and the duplicate-version branch have to
  // agree on whether a re-run is safe.
  it('describes re-running the same way everywhere', () => {
    expect(releaseSh).not.toMatch(/do NOT re-run|each step is idempotent/i);
    expect(releaseSh).toMatch(/^# If interrupted, re-run with the same version/m);
  });
});

describe('release.sh mcp-publisher download', () => {
  it('pins a release, fails on HTTP errors, and checks the archive against a pinned digest', () => {
    const step8 = code(between('step 8 "', 'step 9 "'));
    expect(code(releaseSh)).not.toMatch(/releases\/latest/);
    expect(releaseSh).toMatch(/^MCP_PUBLISHER_VERSION=v\d+\.\d+\.\d+$/m);
    expect(step8).toMatch(/curl -fsSL/);
    expect(step8).toMatch(/mcp_publisher_sha256/);
    // One digest per platform the OS/arch detection can produce.
    for (const p of [
      'darwin_amd64',
      'darwin_arm64',
      'linux_amd64',
      'linux_arm64',
      'windows_amd64',
      'windows_arm64',
    ]) {
      expect(releaseSh, p).toMatch(new RegExp(`${p}\\) echo [0-9a-f]{64} ;;`));
    }
  });
});

describe.skipIf(!BASH)('release.sh syntax', () => {
  it(
    'parses under bash -n',
    () => {
      execFileSync(BASH as string, [
        '-n',
        fileURLToPath(new URL('../../release.sh', import.meta.url)),
      ]);
    },
    BASH_TIMEOUT_MS,
  );
});
