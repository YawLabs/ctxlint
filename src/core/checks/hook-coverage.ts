import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseTree, findNodeAtLocation, getNodeValue, type Node } from 'jsonc-parser';
import { stripBom, fileExists } from '../../utils/fs.js';
import { offsetToPosition } from '../../utils/positions.js';
import type { LintIssue } from '../types.js';

/**
 * hook-coverage/dead-hook — the INVERSE of tier-tokens/hard-enforcement-missing.
 *
 * tier-tokens checks the FORWARD direction: an inviolable rule with no hook to
 * enforce it. This checks the BACKWARD direction: a hook (or a permissions
 * entry) in .claude/settings.json that points at a script/path which no longer
 * exists on disk. A PreToolUse hook whose `command` references a deleted script
 * silently NO-OPS — Claude Code can't run a file that isn't there, so the gate
 * the user thinks is protecting them does nothing. That's a dangerous false
 * sense of security (the canonical example: a `--admin`-blocking gate that was
 * renamed, so the block silently stopped firing).
 *
 * Sources scanned: project `.claude/settings.json` + `.claude/settings.local.json`
 * by default. The user-global `~/.claude/settings.json` is scanned ONLY when the
 * caller opts in (`--hooks-global` / `hooksGlobal`), mirroring the opt-in posture
 * the session + skills pillars use for reading outside the project directory.
 */

interface SettingsSource {
  /** Absolute path of the settings file. */
  filePath: string;
  /** Display path used in the issue (relative for project, ~/.claude/... for user). */
  displayPath: string;
  /** True for the user-global file (findings can't be opened in the repo). */
  isUserGlobal: boolean;
  content: string;
  tree: Node | undefined;
}

/**
 * A path candidate extracted from a hook command or a permissions entry, with
 * the JSON value it came from (for position lookup) and whether it resolved.
 */
interface PathCandidate {
  /** The raw script-path token as written in settings. */
  raw: string;
  /** Absolute resolved path, or null if it referenced an env var we can't resolve. */
  resolved: string | null;
}

function loadSettingsSources(
  projectRoot: string,
  homeDir: string,
  includeUserGlobal: boolean,
): SettingsSource[] {
  const home = homeDir;
  const candidates: Array<{ filePath: string; displayPath: string; isUserGlobal: boolean }> = [
    {
      filePath: path.join(projectRoot, '.claude', 'settings.json'),
      displayPath: path.join('.claude', 'settings.json'),
      isUserGlobal: false,
    },
    {
      filePath: path.join(projectRoot, '.claude', 'settings.local.json'),
      displayPath: path.join('.claude', 'settings.local.json'),
      isUserGlobal: false,
    },
  ];
  // User-global ~/.claude/settings.json is read only on explicit opt-in, so the
  // default run never touches files outside the project directory.
  if (includeUserGlobal) {
    candidates.push({
      filePath: path.join(home, '.claude', 'settings.json'),
      displayPath: '~/.claude/settings.json',
      isUserGlobal: true,
    });
  }

  const sources: SettingsSource[] = [];
  for (const c of candidates) {
    let content: string;
    try {
      content = stripBom(fs.readFileSync(c.filePath, 'utf-8'));
    } catch {
      continue; // missing file is expected
    }
    const tree = parseTree(content, [], { allowTrailingComma: true });
    sources.push({ ...c, content, tree });
  }
  return sources;
}

/**
 * Expand the env vars Claude Code documents for hook/settings paths. Returns
 * null if the string still contains an UNresolvable `$VAR` after expansion --
 * we must not flag a path we can't actually resolve (that would be a false
 * "dead hook" report).
 */
function expandPath(
  raw: string,
  projectRoot: string,
  homeDir: string,
  platform: NodeJS.Platform,
): string | null {
  let s = raw;
  // Leading ~ -> home dir.
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = path.join(homeDir, s.slice(1));
  }
  const replacements: Record<string, string> = {
    CLAUDE_PROJECT_DIR: projectRoot,
    CLAUDE_CONFIG_DIR: path.join(homeDir, '.claude'),
    HOME: homeDir,
    USERPROFILE: homeDir,
  };
  s = s.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, name: string) =>
    name in replacements ? replacements[name] : m,
  );
  // Windows-style %VAR% (settings authored on Windows). Expand the same
  // documented vars (case-insensitively, matching cmd.exe semantics); leave
  // anything else in place so the bail-out below catches it.
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => {
    const upper = name.toUpperCase();
    return upper in replacements ? replacements[upper] : m;
  });
  // Any remaining $VAR or %VAR% means we can't resolve -> bail (don't
  // false-positive a path we can't actually check).
  if (/\$\{?[A-Za-z_]/.test(s)) return null;
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(s)) return null;
  // MSYS / Git Bash drive path (`/c/Users/x`) -> Win32 (`c:/Users/x`) so the
  // existence check resolves. Must run before isAbsolute / resolve.
  s = translateMsysDrivePath(s, platform);
  if (!path.isAbsolute(s)) s = path.resolve(projectRoot, s);
  return s;
}

// A token looks like a script PATH (vs an inline shell matcher like
// "npm login") when it has a path separator and ends in a script-ish
// extension, OR starts with an explicit path prefix. This is intentionally
// conservative: a false negative (missing a dead hook) is safer than a false
// positive (flagging "git push" as a missing file).
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|js|mjs|cjs|ts|py|rb|pl|ps1|cmd|bat|exe)$/i;
const PATH_PREFIX = /^(~|\.\.?[/\\]|[/\\]|\$\{?[A-Za-z_]|[A-Za-z]:[/\\])/;

function looksLikePath(token: string): boolean {
  const hasSep = token.includes('/') || token.includes('\\');
  if (PATH_PREFIX.test(token)) return true;
  return hasSep && SCRIPT_EXT.test(token);
}

/**
 * Claude Code permission matchers end in a prefix wildcard -- a bare `*`
 * (`Bash(bash /path/gate.sh*)`) or `:*` (`Bash(node gate.js:*)`). The wildcard
 * belongs to the matcher, never the filename, so strip it before deciding
 * path-ness and resolving. Without this, a permission entry that references a
 * real script reads as a missing file purely because of the trailing `*`.
 */
export function stripMatcherWildcard(token: string): string {
  return token.replace(/:?\*+$/, '');
}

/**
 * Git Bash renders a native `/FLAG` argument as `//FLAG` to suppress MSYS path
 * translation, so Windows-authored settings carry tokens like `tasklist //FI`
 * and `taskkill //F`. These are command flags, not filesystem paths: `//`
 * followed by letters with no further separator. A real UNC path
 * (`//host/share`) has a later `/` and is deliberately left alone.
 */
export function isMsysFlag(token: string): boolean {
  return /^\/\/[A-Za-z]+$/.test(token);
}

/**
 * Translate a Git Bash / MSYS drive path (`/c/Users/x`) to its Win32 form
 * (`c:/Users/x`) so the existence check resolves. Windows-only: on POSIX
 * `/c/...` is a genuine absolute path and must never be rewritten.
 */
export function translateMsysDrivePath(s: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return s;
  const m = /^\/([A-Za-z])\/(.*)$/.exec(s);
  return m ? `${m[1]}:/${m[2]}` : s;
}

/**
 * Pull script-path candidates out of a hook command line. A command can be a
 * bare path ("./.claude/hooks/gate.sh") or an interpreter invocation
 * ("bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh\" --flag"). We tokenize on
 * whitespace, strip surrounding quotes, and keep tokens that look like paths.
 */
function extractCommandPaths(
  command: string,
  projectRoot: string,
  homeDir: string,
  platform: NodeJS.Platform,
): PathCandidate[] {
  const tokens = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const out: PathCandidate[] = [];
  for (const t of tokens) {
    const token = t.replace(/^['"]|['"]$/g, '');
    // Strip the trailing matcher wildcard first: it belongs to the permission
    // rule, not the filename, and would otherwise fail the existence check.
    const pathToken = stripMatcherWildcard(token);
    // MSYS `//FLAG` tokens (e.g. `taskkill //F`) are Windows command flags, not
    // paths -- drop them so they aren't reported as missing files.
    if (isMsysFlag(pathToken)) continue;
    if (!looksLikePath(pathToken)) continue;
    // Keep the original token in `raw` for the message; resolve the stripped form.
    out.push({ raw: token, resolved: expandPath(pathToken, projectRoot, homeDir, platform) });
  }
  return out;
}

/**
 * Permissions entries are usually tool matchers ("Bash(npm login)"), not file
 * paths -- but some setups reference a script directly. We extract any
 * path-shaped token from the entry (including from inside a `Tool(...)` wrapper)
 * and verify those; non-path entries yield nothing.
 */
function extractPermissionPaths(
  entry: string,
  projectRoot: string,
  homeDir: string,
  platform: NodeJS.Platform,
): PathCandidate[] {
  // Unwrap a single Tool(...) wrapper if present, e.g. "Bash(./x.sh)".
  const inner = entry.replace(/^[A-Za-z]+\((.*)\)$/, '$1');
  return extractCommandPaths(inner, projectRoot, homeDir, platform);
}

function lineForPath(source: SettingsSource, jsonPath: (string | number)[]): number {
  if (!source.tree) return 1;
  const node = findNodeAtLocation(source.tree, jsonPath);
  if (!node) return 1;
  return offsetToPosition(source.content, node.offset).line;
}

interface SettingsShape {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  hooks?: Record<
    string,
    Array<{ matcher?: string; hooks?: Array<{ command?: string; type?: string }> }>
  >;
}

function checkSource(
  source: SettingsSource,
  projectRoot: string,
  homeDir: string,
  platform: NodeJS.Platform,
): LintIssue[] {
  if (!source.tree) return [];
  const data = getNodeValue(source.tree) as SettingsShape | undefined;
  if (!data || typeof data !== 'object') return [];

  const issues: LintIssue[] = [];

  const report = (cand: PathCandidate, line: number, origin: string) => {
    // Unresolvable (env-var) paths are skipped -- can't prove they're dead.
    if (cand.resolved === null) return;
    if (fileExists(cand.resolved)) return;
    const where = source.isUserGlobal ? ` (in ${source.displayPath})` : '';
    issues.push({
      severity: 'warning',
      check: 'hook-coverage',
      ruleId: 'hook-coverage/dead-hook',
      line,
      message: `${origin} references "${cand.raw}" which does not exist on disk${where} — the gate silently no-ops`,
      suggestion: source.isUserGlobal
        ? `Restore the script at ${cand.resolved}, or remove the dead entry from ${source.displayPath}.`
        : `Restore the script, fix the path, or remove the dead entry. A PreToolUse hook pointing at a missing script does not block anything.`,
    });
  };

  // --- Hooks ---
  const hooks = data.hooks ?? {};
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    matchers.forEach((matcher, mi) => {
      const subHooks = matcher?.hooks;
      if (!Array.isArray(subHooks)) return;
      subHooks.forEach((h, hi) => {
        if (!h || typeof h.command !== 'string') return;
        const line = lineForPath(source, ['hooks', event, mi, 'hooks', hi, 'command']);
        for (const cand of extractCommandPaths(h.command, projectRoot, homeDir, platform)) {
          report(cand, line, `${event} hook`);
        }
      });
    });
  }

  // --- Permissions ---
  const perms = data.permissions ?? {};
  for (const listName of ['allow', 'deny', 'ask'] as const) {
    const list = perms[listName];
    if (!Array.isArray(list)) continue;
    list.forEach((entry, i) => {
      if (typeof entry !== 'string') return;
      const line = lineForPath(source, ['permissions', listName, i]);
      for (const cand of extractPermissionPaths(entry, projectRoot, homeDir, platform)) {
        report(cand, line, `permissions.${listName} entry`);
      }
    });
  }

  return issues;
}

/**
 * Cross-cutting check (no per-file input): scans the project + user
 * `.claude/settings.json` files for hook/permission entries pointing at
 * scripts that no longer exist on disk.
 */
export interface HookCoverageOptions {
  /**
   * When true, also scan the user-global `~/.claude/settings.json`. Off by
   * default so the standard run stays inside the project directory (the same
   * opt-in contract the session + skills pillars follow). Wired to the
   * `--hooks-global` CLI flag / `hooksGlobal` audit option.
   */
  userGlobal?: boolean;
}

export async function checkHookCoverage(
  projectRoot: string,
  // homeDir is injectable so tests can isolate from the real user-global
  // ~/.claude/settings.json. Production callers omit it (defaults to the OS home).
  homeDir: string = os.homedir(),
  options: HookCoverageOptions = {},
  // platform is injectable so tests can exercise the Windows-only MSYS drive-path
  // translation deterministically. Production callers omit it (defaults to the
  // running OS).
  platform: NodeJS.Platform = process.platform,
): Promise<LintIssue[]> {
  const sources = loadSettingsSources(projectRoot, homeDir, options.userGlobal ?? false);
  const issues: LintIssue[] = [];
  for (const source of sources) {
    issues.push(...checkSource(source, projectRoot, homeDir, platform));
  }
  return issues;
}
