import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripBom, type PackageJson } from '../../utils/fs.js';

/**
 * Static analysis behind `commands/unknown-subcommand`.
 *
 * `commands/*` validates `npm run` script names, make targets and npx packages.
 * It does NOT validate subcommands of the binary the repo itself ships. Two
 * `@yawlabs/*-mcp` servers independently shipped a release script telling
 * operators to verify a freshly built binary with `<bin> doctor --json` -- no
 * such subcommand existed. Worse than a no-op: unknown args fall through to
 * stdio MCP server startup, so the "verification step" blocks forever and
 * reads as a hang.
 *
 * The rule only fires when the CLI's subcommand set can be resolved with
 * CONFIDENCE. A wrong "that subcommand does not exist" is worse than silence,
 * because the reader's correct doc looks broken. So the resolver is tiered and
 * bails loudly-to-silently:
 *
 *   1. Commander `.command('<name>')` -- high confidence, covers most Node CLIs.
 *   2. Hand-rolled `process.argv[2]` dispatch, accepted ONLY when the set is
 *      CLOSED: every comparison is against a string literal.
 *   3. Anything open (compared against a variable, used as a lookup key,
 *      `Object.keys`, a non-literal `.includes`) -> null, emit nothing.
 *   4. No recognizable dispatcher, unreadable entry, or a bundled/minified
 *      entry -> null.
 *
 * Tier 2 is what buys coverage on the corpus that produced the bug: every
 * `@yawlabs/*-mcp` server hand-rolls its argv dispatch, so a Commander-only
 * detector structurally could not fire on them.
 *
 * Never executes the binary. The motivating bug is a CLI that HANGS on
 * unrecognized input; shelling out to it with `--help` is how a linter
 * inherits that hang.
 */

/** A binary this project declares in `package.json#bin`. */
export interface OwnedBin {
  /** On-PATH command name (a `bin` key). */
  name: string;
  /** Project-relative entry path the key points at. */
  entry: string;
}

/** Extensions stripped when matching a documented token against a bin name. */
const BIN_EXT = /\.(exe|cmd|bat|ps1|js|mjs|cjs|ts)$/i;

/**
 * A file this big, or with a line this long, is a bundle. Static scanning of
 * a bundle is worse than useless: it picks up the `.command(...)` calls of
 * every vendored dependency and produces a confident, wrong subcommand set.
 * ctxlint's own `bin` points at a 69k-line esbuild bundle, so this gate is
 * what keeps the rule from misfiring on this very repo.
 */
const MAX_ENTRY_BYTES = 150_000;
const MAX_ENTRY_LINE = 500;

/** Depth-1 follow of a `bin/foo.js` shim into the real entry. */
const MAX_FOLLOW = 1;

/**
 * Read `package.json#bin` into the owned-binary set. Handles both the string
 * form (`"bin": "./cli.js"`, named after the package) and the object form.
 * Scoped package names contribute their unscoped basename, which is what npm
 * links onto PATH.
 */
export function ownedBins(pkgJson: PackageJson | null): OwnedBin[] {
  if (!pkgJson || !pkgJson.bin) return [];
  const out: OwnedBin[] = [];
  if (typeof pkgJson.bin === 'string') {
    const raw = pkgJson.name ?? '';
    const name = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
    if (name) out.push({ name, entry: pkgJson.bin });
    return out;
  }
  for (const [name, entry] of Object.entries(pkgJson.bin)) {
    if (typeof entry === 'string' && name) out.push({ name, entry });
  }
  return out;
}

/** Normalize a documented argv[0] token to a bare command name, or null. */
export function commandNameOf(token: string): string | null {
  let t = token.trim().replace(/^["']|["']$/g, '');
  if (!t) return null;
  // Basename across both separators; docs mix `./bin/x` and `.\bin\x`.
  const cut = Math.max(t.lastIndexOf('/'), t.lastIndexOf('\\'));
  if (cut >= 0) t = t.slice(cut + 1);
  t = t.replace(BIN_EXT, '');
  return t || null;
}

/** Resolve a `bin` entry path to a readable file, trying common suffixes. */
function resolveEntry(projectRoot: string, entry: string): string | null {
  const base = path.resolve(projectRoot, entry);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      // keep trying
    }
  }
  return null;
}

/** Read an entry file, refusing anything that looks bundled or minified. */
function readEntry(abs: string): string | null {
  let src: string;
  try {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_ENTRY_BYTES) return null;
    src = stripBom(fs.readFileSync(abs, 'utf-8'));
  } catch {
    return null;
  }
  for (const line of src.split('\n')) {
    if (line.length > MAX_ENTRY_LINE) return null;
  }
  return src;
}

/**
 * A thin `bin/foo.js` shim (`#!/usr/bin/env node` + one relative import) is a
 * common shape; the dispatcher lives one hop away. Returns the single relative
 * specifier when the file is a shim, else null.
 */
function shimTarget(src: string): string | null {
  const meaningful = src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#!') && !l.startsWith('//') && !l.startsWith('*'));
  if (meaningful.length > 12) return null;
  const specs = new Set<string>();
  for (const m of src.matchAll(/(?:^|\s)(?:import|require)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
    specs.add(m[1]);
  }
  for (const m of src.matchAll(/^\s*import\s+[^'"]*from\s*['"](\.[^'"]+)['"]/gm)) {
    specs.add(m[1]);
  }
  return specs.size === 1 ? [...specs][0] : null;
}

/**
 * Two views of an entry file, both with comments removed:
 *
 *  - `code` also blanks the BODY of every string and template literal. This is
 *    what the openness checks read, so English prose can never masquerade as a
 *    dispatch signal.
 *  - `literals` keeps string bodies, so the closed-set collection can read them.
 *
 * This is not a JS parser and does not need to be. A regex literal containing
 * `//` could be mis-tokenized; the failure direction is losing literals, which
 * yields an empty set, which yields null, which emits nothing.
 *
 * The fixture proves why this matters: `cli.js` carries the comment "an unknown
 * subcommand in the docs reads as a hang", and a raw scan reads that `in` as
 * the `in` operator and bails on a dispatch that is perfectly closed.
 */
function stripComments(src: string): { code: string; literals: string } {
  let code = '';
  let literals = '';
  let i = 0;
  const push = (ch: string, inString: boolean) => {
    literals += ch;
    code += inString && ch !== '\n' ? ' ' : ch;
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        // Preserve newlines so line-anchored patterns keep their geometry.
        if (src[i] === '\n') push('\n', false);
        i++;
      }
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      push(ch, false);
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          push(src[i], true);
          if (i + 1 < src.length) push(src[i + 1], true);
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        push(src[i], true);
        i++;
      }
      if (i < src.length) push(src[i], false);
      i++;
      continue;
    }
    push(ch, false);
    i++;
  }
  return { code, literals };
}

/** True when a `.command(` takes a computed name -- an open set. */
function commanderIsOpen(code: string): boolean {
  return /\.command\(\s*[^'"`\s)]/.test(code);
}

/** Extract the subcommand set from Commander's `.command('<name>')` calls. */
function commanderSubcommands(code: string, literals: string): Set<string> | null {
  // A `.command(` whose first argument is not a string literal means the names
  // are computed -- open set, bail rather than report a partial one.
  if (commanderIsOpen(code)) return null;
  const found = new Set<string>();
  for (const m of literals.matchAll(/\.command\(\s*(['"`])([^'"`\n]+)\1/g)) {
    // Commander allows `'clone <source> [dest]'`; the name is the first word.
    const name = m[2].trim().split(/\s+/)[0];
    if (name && !name.startsWith('<') && !name.startsWith('[')) found.add(name);
  }
  return found.size > 0 ? found : null;
}

/** Identifiers a comparison may use without opening the set. */
const SENTINEL = /^(undefined|null|NaN|void)$/;

/**
 * Extract the subcommand set from a hand-rolled `process.argv[2]` dispatch.
 * Returns null when the dispatch is OPEN (any non-literal comparison, lookup
 * indexing, or membership test against a non-literal), or when nothing
 * recognizable was found. That bail-out is the whole precision story.
 *
 * `code` has comments and string bodies removed and drives every openness
 * decision; `literals` keeps string bodies and is where the set is read from.
 */
function argvSubcommands(code: string, literals: string): Set<string> | null {
  const aliases = new Set<string>();
  // `const sub = process.argv[2]`, `let sub = argv[2]`
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.)?argv\[2\]/g,
  )) {
    aliases.add(m[1]);
  }
  // `const sub = process.argv.slice(2)[0]`
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.)?argv\.slice\(\s*2\s*\)\s*\[\s*0\s*\]/g,
  )) {
    aliases.add(m[1]);
  }
  // `const [, , sub] = process.argv`
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s*\[\s*,\s*,\s*([A-Za-z_$][\w$]*)\s*\]\s*=\s*process\.argv/g,
  )) {
    aliases.add(m[1]);
  }

  const tokens = [...aliases].map((a) => `\\b${a}\\b`);
  if (/(?:process\.)?argv\[2\]/.test(code)) tokens.push('(?:process\\.)?argv\\[2\\]');
  if (tokens.length === 0) return null;
  const tok = `(?:${tokens.join('|')})`;

  // --- openness signals: any of these means the set is not statically closed
  // Compared against an identifier that is not a literal-ish sentinel. A
  // blanked string body reads as whitespace, so `sub === "x"` never lands here.
  const cmpIdent = new RegExp(`${tok}\\s*[=!]==?\\s*([A-Za-z_$][\\w$.]*)`, 'g');
  for (const m of code.matchAll(cmpIdent)) {
    if (!SENTINEL.test(m[1])) return null;
  }
  const identCmp = new RegExp(`([A-Za-z_$][\\w$.]*)\\s*[=!]==?\\s*${tok}`, 'g');
  for (const m of code.matchAll(identCmp)) {
    if (!SENTINEL.test(m[1])) return null;
  }
  // Used as a lookup key, or membership-tested against something non-literal.
  if (new RegExp(`\\[\\s*${tok}\\s*\\]`).test(code)) return null;
  if (new RegExp(`Object\\.(keys|values|entries)\\([^)]*\\)[^\\n]*${tok}`).test(code)) return null;
  if (new RegExp(`${tok}\\s+in\\s+`).test(code)) return null;
  if (new RegExp(`\\bhasOwnProperty\\(\\s*${tok}`).test(code)) return null;
  // `.includes(sub)` is fine only when the receiver is a literal array.
  const includesRe = new RegExp(`(\\S*)\\.includes\\(\\s*${tok}\\s*\\)`, 'g');
  for (const m of code.matchAll(includesRe)) {
    if (!m[1].endsWith(']')) return null;
  }

  // --- closed-set collection (string bodies intact)
  const found = new Set<string>();
  // `tok` is entirely non-capturing, so the quote is group 1 and the literal
  // body is group 2.
  const eqLit = new RegExp(`${tok}\\s*[=!]==?\\s*(['"\`])([^'"\`\\n]*)\\1`, 'g');
  for (const m of literals.matchAll(eqLit)) if (m[2]) found.add(m[2]);
  const litEq = new RegExp(`(['"\`])([^'"\`\\n]*)\\1\\s*[=!]==?\\s*${tok}`, 'g');
  for (const m of literals.matchAll(litEq)) if (m[2]) found.add(m[2]);

  // `switch (sub) { case 'x': ... }` -- only the switch discriminated on the
  // argv token, so slice the block rather than harvesting every `case` in the
  // file.
  const switchRe = new RegExp(`switch\\s*\\(\\s*${tok}\\s*\\)\\s*\\{`, 'g');
  for (const m of literals.matchAll(switchRe)) {
    const body = literals.slice((m.index ?? 0) + m[0].length);
    const end = body.indexOf('\n}');
    const block = end >= 0 ? body.slice(0, end) : body;
    for (const c of block.matchAll(/\bcase\s+(['"`])([^'"`\n]*)\1/g)) {
      if (c[2]) found.add(c[2]);
    }
  }

  // A literal array membership test contributes its whole set.
  const arrIncludes = new RegExp(`\\[([^\\]\\n]*)\\]\\.includes\\(\\s*${tok}\\s*\\)`, 'g');
  for (const m of literals.matchAll(arrIncludes)) {
    for (const lit of m[1].matchAll(/(['"`])([^'"`]*)\1/g)) {
      if (lit[2]) found.add(lit[2]);
    }
  }

  return found.size > 0 ? found : null;
}

/**
 * Resolve the subcommands a bin's entry file dispatches, or null when the set
 * cannot be determined with confidence. Null ALWAYS means "emit nothing".
 */
export function knownSubcommands(projectRoot: string, entry: string): Set<string> | null {
  let abs = resolveEntry(projectRoot, entry);
  for (let hop = 0; abs && hop <= MAX_FOLLOW; hop++) {
    const src = readEntry(abs);
    if (src === null) return null;
    const { code, literals } = stripComments(src);

    const commander = commanderSubcommands(code, literals);
    if (commander) return commander;
    // A `.command(` with a computed name was seen -> open set, stop here.
    if (commanderIsOpen(code)) return null;

    const argv = argvSubcommands(code, literals);
    if (argv) return argv;

    if (hop === MAX_FOLLOW) break;
    const target = shimTarget(src);
    if (!target) break;
    abs = resolveEntry(path.dirname(abs), target);
  }
  return null;
}

/** One documented `<bin> <subcommand>` invocation found in a context file. */
export interface BinInvocation {
  bin: string;
  sub: string;
  /** The full command text, for the message. */
  cmd: string;
  /** 1-indexed line in the context file. */
  line: number;
}

/** Runners that delegate to the named package: `npx ctxlint audit`. */
const DELEGATORS = new Set(['npx', 'bunx', 'sudo', 'time']);
const TWO_TOKEN_DELEGATORS = /^(?:pnpm|npm|yarn|bun)\s+(?:exec|dlx)\s+/;

/** A subcommand is a bareword: not a flag, path, assignment, or filename. */
const SUBCOMMAND_SHAPE = /^[a-z][a-z0-9:_-]*$/i;

/**
 * Find `<ownedBin> <subcommand>` invocations in a context file.
 *
 * This does its OWN extraction rather than reading `file.references.commands`,
 * for two reasons. The shared extractor gates on a fixed COMMON_COMMANDS list
 * (npm/npx/make/cargo/...), so a project's own binary -- `./bin/tailscale-mcp
 * doctor`, `postgres-mcp doctor --json` -- is never extracted at all and a rule
 * built on it would ship inert. And scanning for names the project actually
 * declares is strictly more precise than widening the global extractor, which
 * would start pulling directory listings out of untagged fences.
 */
export function findBinInvocations(content: string, binNames: Set<string>): BinInvocation[] {
  if (binNames.size === 0) return [];
  const out: BinInvocation[] = [];
  const lines = content.split('\n');

  let inFence = false;
  let fenceLang = '';
  let inHtmlComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // HTML comments carry commentary ABOUT commands, not commands to run --
    // the fixtures themselves prove it, describing the defect in prose that
    // quotes the very invocation being flagged.
    if (!inHtmlComment && trimmed.includes('<!--')) {
      inHtmlComment = !trimmed.includes('-->');
      continue;
    }
    if (inHtmlComment) {
      if (trimmed.includes('-->')) inHtmlComment = false;
      continue;
    }

    if (trimmed.startsWith('```')) {
      if (!inFence) {
        inFence = true;
        fenceLang = trimmed.slice(3).trim().toLowerCase();
      } else {
        inFence = false;
        fenceLang = '';
      }
      continue;
    }

    const candidates: string[] = [];
    if (inFence) {
      // Mirror the shared extractor's fence policy: shell-tagged fences and
      // untagged fences carry commands; a `json`/`ts` fence does not.
      if (['bash', 'sh', 'shell', 'zsh', 'console', ''].includes(fenceLang)) {
        if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
          candidates.push(trimmed.replace(/^[$>]\s*/, ''));
        }
      }
    } else {
      if (/^[$>]\s+/.test(trimmed)) candidates.push(trimmed.replace(/^[$>]\s*/, ''));
      for (const m of line.matchAll(/`([^`]+)`/g)) candidates.push(m[1].trim());
    }

    for (const candidate of candidates) {
      const hit = matchBinInvocation(candidate, binNames);
      if (hit) out.push({ ...hit, cmd: candidate, line: i + 1 });
    }
  }
  return out;
}

function matchBinInvocation(
  candidate: string,
  binNames: Set<string>,
): { bin: string; sub: string } | null {
  // Only the FIRST command on the line is considered; `foo && bar baz` is two
  // commands and the second is analysed on its own terms elsewhere.
  let s = candidate.trim();
  const stop = s.search(/&&|\|\||[;|]/);
  if (stop >= 0) s = s.slice(0, stop).trim();
  s = s.replace(TWO_TOKEN_DELEGATORS, '');

  let tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 0) {
    const head = commandNameOf(tokens[0]);
    if (head && DELEGATORS.has(head)) {
      tokens = tokens.slice(1);
      while (tokens.length > 0 && tokens[0].startsWith('-')) tokens = tokens.slice(1);
      continue;
    }
    break;
  }
  if (tokens.length < 2) return null;

  const bin = commandNameOf(tokens[0]);
  if (!bin || !binNames.has(bin)) return null;

  for (const raw of tokens.slice(1)) {
    if (raw.startsWith('-')) continue;
    const t = raw.replace(/^["']|["']$/g, '');
    if (!SUBCOMMAND_SHAPE.test(t)) return null; // a path/arg, not a subcommand
    return { bin, sub: t };
  }
  return null;
}
