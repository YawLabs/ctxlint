import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseTree,
  findNodeAtLocation,
  getNodeValue,
  printParseErrorCode,
  type Node,
  type ParseError,
} from 'jsonc-parser';
import { claudeConfigDir, homeDir } from '../../utils/claude-home.js';
import { stripBom, fileExists } from '../../utils/fs.js';
import { offsetToPosition } from '../../utils/positions.js';
import type { LintIssue } from '../types.js';
import { hookShellWords } from './shell-words.js';

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
 *
 * What is checked, and why only that:
 *  - hook `command`s and `Bash(...)`/`PowerShell(...)` permission entries are
 *    shell; their path-shaped words are statted.
 *  - `Read(...)`/`Edit(...)`/`Write(...)` (and the other path tools) use
 *    Claude Code's own path-rule prefixes, which are NOT shell paths -- see
 *    resolveRulePath.
 *  - only `allow` entries and hooks are reported. A `deny`/`ask` rule naming a
 *    missing path is a guard against the path appearing (`Read(./.env)`), and
 *    it is working as written.
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
  /**
   * `shell` for a word of a hook command or `Bash(...)` rule; `rule` for a
   * Read/Edit-style rule body, which follows Claude Code's path-rule syntax
   * and so has its own alternate spellings (see ruleVariant).
   */
  kind: 'shell' | 'rule';
}

/**
 * Where `~` and the user-global settings resolve. `configDir` is Claude Code's
 * config directory (claudeConfigDir: `CLAUDE_CONFIG_DIR`, else
 * `<home>/.claude`); either may be '' when nothing resolves.
 */
interface Homes {
  home: string;
  configDir: string;
}

function loadSettingsSources(
  projectRoot: string,
  homes: Homes,
  includeUserGlobal: boolean,
): SettingsSource[] {
  // Display paths use `/` on every OS: they are shown in messages, and a
  // message that differs by platform makes reports non-portable.
  const candidates: Array<{ filePath: string; displayPath: string; isUserGlobal: boolean }> = [
    {
      filePath: path.join(projectRoot, '.claude', 'settings.json'),
      displayPath: '.claude/settings.json',
      isUserGlobal: false,
    },
    {
      filePath: path.join(projectRoot, '.claude', 'settings.local.json'),
      displayPath: '.claude/settings.local.json',
      isUserGlobal: false,
    },
  ];
  // User-global ~/.claude/settings.json is read only on explicit opt-in, so the
  // default run never touches files outside the project directory. It lives
  // in Claude Code's config dir, which CLAUDE_CONFIG_DIR can move.
  if (includeUserGlobal && homes.configDir) {
    const isDefault =
      homes.home !== '' && path.resolve(homes.configDir) === path.resolve(homes.home, '.claude');
    candidates.push({
      filePath: path.join(homes.configDir, 'settings.json'),
      displayPath: isDefault
        ? '~/.claude/settings.json'
        : path.join(homes.configDir, 'settings.json').replace(/\\/g, '/'),
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
    // A malformed file is skipped with one notice, not checked on the partial
    // tree jsonc-parser recovers: entries after the error are silently lost,
    // so "no dead hooks" would be a claim about half a file. Same leniency
    // (jsonc, trailing commas) and same stderr channel as tier-tokens.
    const errors: ParseError[] = [];
    const tree = parseTree(content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      console.warn(
        `ctxlint: hook-coverage skipped ${c.displayPath}: could not parse (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset})`,
      );
      continue;
    }
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
  homes: Homes,
  platform: NodeJS.Platform,
): string | null {
  let s = raw;
  // Leading ~ -> home dir. With no home there is nothing to join onto (it
  // would yield a cwd-relative path), so the path cannot be checked.
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    if (!homes.home) return null;
    s = path.join(homes.home, s.slice(1));
  }
  const replacements: Record<string, string> = { CLAUDE_PROJECT_DIR: projectRoot };
  if (homes.configDir) replacements.CLAUDE_CONFIG_DIR = homes.configDir;
  if (homes.home) {
    replacements.HOME = homes.home;
    replacements.USERPROFILE = homes.home;
  }
  s = s.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, name: string) =>
    Object.hasOwn(replacements, name) ? replacements[name] : m,
  );
  // Windows-style %VAR% (settings authored on Windows). Expand the same
  // documented vars (case-insensitively, matching cmd.exe semantics); leave
  // anything else in place so the bail-out below catches it.
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => {
    const upper = name.toUpperCase();
    return Object.hasOwn(replacements, upper) ? replacements[upper] : m;
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
 *
 * A DOUBLED leading slash (`//c/Users/x`) is accepted too, for two reasons.
 * In a `Read(...)`/`Edit(...)` rule `//` is Claude Code's documented
 * filesystem-absolute prefix, and on Windows paths are normalized to POSIX
 * form before matching, so `Read(//c/Users/x/**)` is the documented way to name
 * `C:\Users\x` (code.claude.com/docs/en/permissions, "How path patterns
 * match"). In shell, Git Bash renders a drive path that way when suppressing
 * MSYS translation. Left untranslated it looks like a UNC path, `fileExists`
 * fails, and a live directory gets reported as a dead gate -- which has led to
 * correct entries being deleted on the linter's advice.
 *
 * The single-letter capture is what keeps this safe for genuine UNC paths: a
 * real `//host/share` has a multi-character hostname, and a one-letter UNC host
 * is not a thing in practice. `//FLAG` tokens are handled earlier by
 * `isMsysFlag` (no second slash, so they never reach here).
 */
export function translateMsysDrivePath(s: string, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return s;
  const m = /^\/{1,2}([A-Za-z])\/(.*)$/.exec(s);
  return m ? `${m[1]}:/${m[2]}` : s;
}

/**
 * A candidate did not exist as resolved. Try the small set of alternate
 * readings of the same token; if one of them IS on disk, this is not a dead
 * gate -- the target is present and the path FORM is wrong, which is a
 * different fix (correct the spelling) from the dead-hook fix (restore the
 * script or drop the entry).
 *
 * Reporting "does not exist on disk" for a target that is plainly there is the
 * expensive failure mode: it reads as authoritative, and the suggested remedy
 * ("remove the dead entry") destroys a working permission grant.
 *
 * Returns the first variant that exists, or null when the target really is
 * absent under every reading.
 */
function findExistingVariant(
  raw: string,
  projectRoot: string,
  homes: Homes,
  platform: NodeJS.Platform,
): string | null {
  const token = stripMatcherWildcard(raw);
  const variants = new Set<string>();

  // Collapse or add a leading slash on drive-shaped paths, so `//c/x` and
  // `/c/x` are each tried in the other's form.
  if (/^\/{2}[A-Za-z]\//.test(token)) variants.add(token.slice(1));
  if (/^\/[A-Za-z]\//.test(token)) variants.add(`/${token}`);
  // An absolute-looking token that is really repo-relative (a leading slash
  // typo on `.claude/hooks/gate.sh`).
  if (token.startsWith('/') && !/^\/{1,2}[A-Za-z]\//.test(token)) {
    variants.add(token.replace(/^\/+/, ''));
  }
  // Separator flip -- settings authored on the other platform.
  if (token.includes('\\')) variants.add(token.replace(/\\/g, '/'));

  for (const v of variants) {
    const resolved = expandPath(v, projectRoot, homes, platform);
    if (resolved !== null && fileExists(resolved)) return resolved;
  }
  return null;
}

/**
 * Windows command flags written with a single slash (`cmd /c dir`,
 * `taskkill /F /IM x.exe`): one slash, then letters, no further separator.
 * Win32 only -- on POSIX `/tmp` is a path.
 */
function isWin32SlashFlag(token: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && /^\/[A-Za-z?][A-Za-z0-9:?]*$/.test(token);
}

/**
 * Pull script-path candidates out of a hook command line or a `Bash(...)`
 * rule body. A command can be a bare path ("./.claude/hooks/gate.sh") or an
 * interpreter invocation ("bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/gate.sh\"
 * --flag"). Words are split shell-style (hookShellWords), `--flag=value` and
 * `VAR=value` contribute their value, and only path-shaped words are kept.
 *
 * `matcher` is set for permission rules, whose trailing `*` / `:*` is the
 * rule's prefix wildcard rather than part of a filename.
 */
function extractCommandPaths(
  command: string,
  projectRoot: string,
  homes: Homes,
  platform: NodeJS.Platform,
  matcher: boolean,
): PathCandidate[] {
  const out: PathCandidate[] = [];
  for (const word of hookShellWords(command)) {
    if (word.redirectTarget) continue;
    // `--config=./eslint.config.js`, `FOO=./x.sh`: the value is the path.
    const assigned = /^(?:--?[A-Za-z0-9][\w-]*|[A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(word.text);
    const token = assigned ? assigned[1] : word.text;
    // Strip the trailing matcher wildcard first: it belongs to the permission
    // rule, not the filename, and would otherwise fail the existence check.
    const pathToken = matcher ? stripMatcherWildcard(token) : token;
    // A URL (`curl -fsSL https://get.example.org/install.sh`) is not a file.
    if (pathToken.includes('://')) continue;
    // MSYS `//FLAG` tokens (e.g. `taskkill //F`) and native `/FLAG` tokens on
    // Windows are command flags, not paths.
    if (isMsysFlag(pathToken) || isWin32SlashFlag(pathToken, platform)) continue;
    // A wildcard surviving the trailing-matcher strip is a mid-token glob
    // (e.g. `/logs/*.json`, `/c/foo/*.sh`), not a single file we can stat --
    // skip rather than report a phantom "missing file" (false negative is
    // safer than a false positive, per the module contract above).
    if (/[*?]/.test(pathToken)) continue;
    if (!looksLikePath(pathToken)) continue;
    // Keep the original token in `raw` for the message; resolve the stripped form.
    out.push({
      raw: token,
      resolved: expandPath(pathToken, projectRoot, homes, platform),
      kind: 'shell',
    });
  }
  return out;
}

/** Tools whose rule body is a Claude Code path pattern rather than shell. */
const PATH_RULE_TOOLS = new Set([
  'Read',
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
]);
/** Tools whose rule body is a command line. */
const COMMAND_RULE_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * Resolve a Read/Edit-style rule body to the path it names, per Claude Code's
 * permission-rule syntax (code.claude.com/docs/en/permissions, "How path
 * patterns match"), which is NOT shell syntax:
 *
 *   `//path`  filesystem-absolute (`//c/Users/x` names `C:\Users\x` on Windows)
 *   `~/path`  home-relative
 *   `/path`   relative to the SETTINGS SOURCE: the project root for project
 *             and local settings, the config dir (`configDir`, default
 *             `<homeDir>/.claude`) for the user-global file.
 *             `Read(/docs/**)` means `<project>/docs`, never `/docs`.
 *   `path`, `./path`  relative to the working directory (the project root)
 *
 * Trailing `/**` or `/*` segments are dropped so the directory they glob is
 * statted; any other glob, a `!` negation, an env var, or a separator-free
 * bare name yields null (nothing single to check).
 */
export function resolveRulePath(
  body: string,
  projectRoot: string,
  homeDir: string,
  isUserGlobal: boolean,
  platform: NodeJS.Platform,
  configDir: string = homeDir ? path.join(homeDir, '.claude') : '',
): string | null {
  let p = body.trim();
  if (!p || p.startsWith('!') || p.includes('$') || p.includes('%')) return null;
  p = p.replace(/(?:\/\*{1,2})+\/?$/, '');
  if (!p || /[*?[\]{}]/.test(p)) return null;

  if (p.startsWith('//')) {
    if (platform === 'win32') {
      const win = translateMsysDrivePath(p, platform);
      // A drive-less `//x` on Windows has no single on-disk meaning here.
      // Returned unresolved (`c:/Users/x`), which fs accepts on Windows and
      // keeps the result independent of the host OS for tests.
      return win === p ? null : win;
    }
    return path.resolve(p.slice(1));
  }
  if (p === '~' || p.startsWith('~/')) return homeDir ? path.join(homeDir, p.slice(1)) : null;
  if (p.startsWith('/')) {
    const anchor = isUserGlobal ? configDir : projectRoot;
    return anchor ? path.join(anchor, p.slice(1)) : null;
  }
  if (!p.includes('/') && !p.includes('\\')) return null;
  return path.resolve(projectRoot, p);
}

/**
 * The path-rule analogue of findExistingVariant: the one confusion the rule
 * syntax invites is `/x` (settings-source-relative) vs `//x` (absolute). When
 * the other reading exists, return the rule body spelled that way.
 */
function ruleVariant(
  body: string,
  projectRoot: string,
  homes: Homes,
  isUserGlobal: boolean,
  platform: NodeJS.Platform,
): string | null {
  let alt: string | null = null;
  if (body.startsWith('//')) alt = body.slice(1);
  else if (body.startsWith('/')) alt = `/${body}`;
  if (alt === null) return null;
  const resolved = resolveRulePath(
    alt,
    projectRoot,
    homes.home,
    isUserGlobal,
    platform,
    homes.configDir,
  );
  return resolved !== null && fileExists(resolved) ? alt : null;
}

/**
 * Path candidates of one permission rule. `Bash(...)` / `PowerShell(...)`
 * bodies are shell and go through extractCommandPaths; path-tool bodies use
 * the rule syntax in resolveRulePath. Anything else -- a bare tool name,
 * `WebFetch(domain:...)`, an MCP tool -- names no file and yields nothing.
 */
function extractPermissionPaths(
  entry: string,
  source: SettingsSource,
  projectRoot: string,
  homes: Homes,
  platform: NodeJS.Platform,
): PathCandidate[] {
  const m = /^([A-Za-z][\w-]*)\(([\s\S]*)\)$/.exec(entry.trim());
  if (!m) return [];
  const [, tool, body] = m;
  if (COMMAND_RULE_TOOLS.has(tool)) {
    return extractCommandPaths(body, projectRoot, homes, platform, true);
  }
  if (!PATH_RULE_TOOLS.has(tool)) return [];
  const resolved = resolveRulePath(
    body,
    projectRoot,
    homes.home,
    source.isUserGlobal,
    platform,
    homes.configDir,
  );
  return resolved === null ? [] : [{ raw: body.trim(), resolved, kind: 'rule' }];
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
  homes: Homes,
  platform: NodeJS.Platform,
): LintIssue[] {
  if (!source.tree) return [];
  const data = getNodeValue(source.tree) as SettingsShape | undefined;
  if (!data || typeof data !== 'object') return [];

  const issues: LintIssue[] = [];

  /**
   * `origin` says what holds the path, and drives the consequence wording: a
   * hook with a missing script does not run (the gate no-ops); an allow rule
   * naming a missing path matches nothing.
   */
  type Origin = { kind: 'hook'; event: string } | { kind: 'allow' };

  const report = (cand: PathCandidate, line: number, origin: Origin) => {
    // Unresolvable (env-var) paths are skipped -- can't prove they're dead.
    if (cand.resolved === null) return;
    if (fileExists(cand.resolved)) return;
    // Findings from every settings file land under one "(project)" path in
    // the report, so the file has to be named in the message itself or a
    // settings.local.json line is indistinguishable from a settings.json one.
    const where = ` (in ${source.displayPath})`;
    // The structured twin of `where`: the audit files the finding under this
    // path. Project sources only -- the user-global file lies outside the
    // project and stays in the "(project)" bucket.
    const file = source.isUserGlobal ? {} : { file: source.displayPath };
    const label = origin.kind === 'hook' ? `${origin.event} hook` : 'permissions.allow entry';
    const consequence =
      origin.kind === 'hook' ? 'the gate silently no-ops' : 'the rule silently matches nothing';

    // The target may be present under a different spelling. Say so instead of
    // asserting it is gone -- the fix is to correct the path, NOT to delete the
    // entry, and the two remedies are opposites.
    const variant =
      cand.kind === 'rule'
        ? ruleVariant(cand.raw, projectRoot, homes, source.isUserGlobal, platform)
        : findExistingVariant(cand.raw, projectRoot, homes, platform);
    if (variant !== null) {
      issues.push({
        severity: 'warning',
        check: 'hook-coverage',
        ruleId: 'hook-coverage/dead-hook',
        line,
        ...file,
        message: `${label} references "${cand.raw}" which does not resolve${where}, but "${variant}" exists — the path form is wrong, so ${consequence}`,
        suggestion: `Rewrite the entry to use "${variant}". Do NOT delete it — the target exists; only the path form is unresolvable.`,
      });
      return;
    }

    const target = source.isUserGlobal ? `the target at ${cand.resolved}` : 'the target';
    issues.push({
      severity: 'warning',
      check: 'hook-coverage',
      ruleId: 'hook-coverage/dead-hook',
      line,
      ...file,
      message: `${label} references "${cand.raw}" which does not exist on disk${where} — ${consequence}`,
      suggestion:
        origin.kind === 'hook'
          ? `Restore ${target}, fix the path, or remove the dead hook from ${source.displayPath}. A ${origin.event} hook pointing at a missing script does not run, so it blocks nothing.`
          : `Restore ${target}, fix the path, or remove the stale entry from ${source.displayPath}. An allow rule naming a missing path grants nothing.`,
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
        for (const cand of extractCommandPaths(h.command, projectRoot, homes, platform, false)) {
          report(cand, line, { kind: 'hook', event });
        }
      });
    });
  }

  // --- Permissions ---
  // `allow` only. A deny/ask rule naming a path that does not exist is a
  // guard against it appearing (`Read(./.env)`, `Read(./secrets/**)` in a repo
  // with no secrets yet) and is doing its job; reporting it as dead invites
  // deleting a working guard.
  const allow = data.permissions?.allow;
  if (Array.isArray(allow)) {
    allow.forEach((entry, i) => {
      if (typeof entry !== 'string') return;
      const line = lineForPath(source, ['permissions', 'allow', i]);
      for (const cand of extractPermissionPaths(entry, source, projectRoot, homes, platform)) {
        report(cand, line, { kind: 'allow' });
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
  // home is injectable so tests can isolate from the real user-global
  // settings. Production callers omit it: the home then resolves the way Claude
  // Code resolves it (homeDir) and the user-global file is read from
  // claudeConfigDir(), which honors CLAUDE_CONFIG_DIR. An explicit home pins
  // the config dir to <home>/.claude, ignoring the ambient CLAUDE_CONFIG_DIR.
  home?: string,
  options: HookCoverageOptions = {},
  // platform is injectable so tests can exercise the Windows-only MSYS drive-path
  // translation deterministically. Production callers omit it (defaults to the
  // running OS).
  platform: NodeJS.Platform = process.platform,
): Promise<LintIssue[]> {
  const homes: Homes = { home: home ?? homeDir(), configDir: claudeConfigDir(home) };
  const sources = loadSettingsSources(projectRoot, homes, options.userGlobal ?? false);
  const issues: LintIssue[] = [];
  for (const source of sources) {
    issues.push(...checkSource(source, projectRoot, homes, platform));
  }
  return issues;
}
