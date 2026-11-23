import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripBom, type PackageJson } from '../../utils/fs.js';
import {
  htmlCommentLineMask,
  inlineCodeSpans,
  nonProseLineMask,
  stripInlineHtmlComments,
} from '../../utils/markdown.js';
import { closestMatch } from './closest-match.js';
import { fenceBlocks, stripWrapperTokens } from './exit-status.js';

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
 * bails to silence on anything it cannot read as a closed set:
 *
 *   1. Commander `.command('<name>')` plus `.alias()`/`.aliases()` and the
 *      implicit `help` command. This is a regex read of the entry file, not a
 *      parse, so it is only as good as its openness checks: a computed name,
 *      `.addCommand(...)`, or the program object handed to another function
 *      (`registerAudit(program)`, which can register commands we never see)
 *      all bail.
 *   2. Hand-rolled `process.argv[2]` dispatch, accepted ONLY when the set is
 *      CLOSED: every use of the argv token is a literal comparison, a switch
 *      discriminant, a literal-array `.includes`, a truthiness test, a log
 *      call, or a call argument guarded by a literal comparison on that line.
 *   3. Anything open (compared against a variable, used as a lookup key,
 *      `Map#has`/`#get`, `Object.keys`, a non-literal `.includes`, a method
 *      call on the token, an unguarded hand-off) -> null, emit nothing.
 *   4. No recognizable dispatcher, unreadable entry, an entry outside the
 *      project root, or a bundled/minified entry -> null.
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

/** True when `abs` is `root` or lies beneath it. */
function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve a `bin` entry (or a shim's import specifier, relative to `baseDir`)
 * to a readable file, trying common suffixes. Refuses anything that lands
 * outside `projectRoot`, lexically or through a symlink: a `bin` of
 * `../../elsewhere/cli.js` is not this project's CLI, and linting a repo must
 * not read files outside it.
 */
function resolveEntry(projectRoot: string, baseDir: string, entry: string): string | null {
  const root = path.resolve(projectRoot);
  const base = path.resolve(baseDir, entry);
  const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`];
  let realRoot = root;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    // fall back to the lexical root
  }
  for (const c of candidates) {
    if (!isInside(root, c)) return null;
    try {
      if (!fs.statSync(c).isFile()) continue;
      if (!isInside(realRoot, fs.realpathSync(c))) return null;
      return c;
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

/** Escape a string for literal use inside a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when the Commander command set cannot be read statically:
 *  - a `.command(` takes a computed name;
 *  - `.addCommand(...)` attaches a command object built elsewhere;
 *  - an object `.command(...)` is called on is handed to another function
 *    (`registerAudit(program)`) or exported, so other modules can register
 *    commands this file never names.
 */
function commanderIsOpen(code: string): boolean {
  if (/\.command\(\s*[^'"`\s)]/.test(code)) return true;
  if (/\.addCommand\(/.test(code)) return true;
  const receivers = new Set<string>();
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*command\(/g)) receivers.add(m[1]);
  for (const m of code.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+Command\(/g,
  )) {
    receivers.add(m[1]);
  }
  for (const r of receivers) {
    const id = reEscape(r);
    // `fn(program)`, `fn(a, program)`, `fn(program, b)` -- but not `if (program)`.
    const handOff = new RegExp(`([A-Za-z_$][\\w$.]*)\\s*\\((?:[^()]*,\\s*)?${id}\\s*[,)]`, 'g');
    for (const m of code.matchAll(handOff)) {
      if (!/^(?:if|while|switch|for|return|typeof|catch)$/.test(m[1])) return true;
    }
    if (new RegExp(`\\bexport\\s+(?:default\\s+${id}\\b|\\{[^}]*\\b${id}\\b)`).test(code))
      return true;
    if (new RegExp(`\\bmodule\\.exports\\s*=\\s*${id}\\b`).test(code)) return true;
  }
  return false;
}

/**
 * Extract the subcommand set from Commander's `.command('<name>')` calls, plus
 * every `.alias('x')` / `.aliases(['x', 'y'])` and the implicit `help` command
 * Commander adds to any program with subcommands (unless turned off with
 * `.addHelpCommand(false)` / `.helpCommand(false)`). Extra names only ever
 * SUPPRESS findings, so over-collecting is the safe direction.
 */
function commanderSubcommands(code: string, literals: string): Set<string> | null {
  if (commanderIsOpen(code)) return null;
  const found = new Set<string>();
  for (const m of literals.matchAll(/\.command\(\s*(['"`])([^'"`\n]+)\1/g)) {
    // Commander allows `'clone <source> [dest]'`; the name is the first word.
    const name = m[2].trim().split(/\s+/)[0];
    // A template literal with a substitution is a computed name.
    if (name.includes('${')) return null;
    if (name && !name.startsWith('<') && !name.startsWith('[')) found.add(name);
  }
  if (found.size === 0) return null;
  for (const m of literals.matchAll(/\.alias\(\s*(['"`])([^'"`\n]+)\1/g)) found.add(m[2].trim());
  for (const m of literals.matchAll(/\.aliases\(\s*\[([^\]]*)\]/g)) {
    for (const lit of m[1].matchAll(/(['"`])([^'"`]*)\1/g)) if (lit[2]) found.add(lit[2]);
  }
  // A non-literal alias is as open as a non-literal name.
  if (/\.aliases?\(\s*[^'"`\s[)]/.test(code)) return null;
  if (!/\.(?:addHelpCommand|helpCommand)\(\s*false\s*\)/.test(code)) found.add('help');
  return found;
}

/** Identifiers a comparison may use without opening the set. */
const SENTINEL = /^(undefined|null|NaN|void)$/;

/**
 * True when every occurrence of the argv token in `code` is one of the shapes
 * that keeps the subcommand set closed. Anything else -- a method call on it,
 * a Map/Set lookup, property access, an assignment to another name, a hand-off
 * to a function with no literal guard -- means the set may live somewhere this
 * scan cannot see.
 *
 * A call argument (`run(sub)`) is accepted only when the same line already
 * compares the token against a literal (`if (sub === 'a') run(sub)`): there
 * the callee receives a value the literal set has vetted. Across lines the
 * guard cannot be seen, so a multi-line `if` block that hands the token off
 * bails -- silence, the safe direction.
 */
function everyUseIsClosed(code: string, tok: string): boolean {
  const literalGuard = new RegExp(
    `${tok}\\s*===?\\s*['"\`]|['"\`]\\s*===?\\s*${tok}|\\]\\s*\\.includes\\(\\s*${tok}`,
  );
  for (const m of code.matchAll(new RegExp(tok, 'g'))) {
    const idx = m.index ?? 0;
    const before = code.slice(Math.max(0, idx - 300), idx);
    const after = code.slice(idx + m[0].length, idx + m[0].length + 300);
    const lineBefore = before.slice(before.lastIndexOf('\n') + 1);

    // Declarations: `const sub = process.argv[2]` (both the alias and the
    // argv read), the slice form, and `const [, , sub] = process.argv`.
    // (Only the argv read itself may sit on the right of a declaration;
    // `const cmd = sub` copies the token to a name this scan does not track.)
    if (
      /^(?:process\.)?argv/.test(m[0]) &&
      /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*$/.test(before)
    ) {
      continue;
    }
    if (/^\s*=\s*(?:process\.)?argv\b/.test(after)) continue;
    if (/^\s*\]\s*=\s*process\.argv\b/.test(after)) continue;
    // Comparisons (the other operand is vetted by the cmpIdent checks).
    if (/^\s*[=!]==?/.test(after) || /[=!]==?\s*$/.test(before)) continue;
    // Switch discriminant.
    if (/\bswitch\s*\(\s*$/.test(before) && /^\s*\)/.test(after)) continue;
    // Literal-array membership (non-literal receivers already bailed).
    if (/\]\s*\.includes\(\s*$/.test(before) && /^\s*\)/.test(after)) continue;
    // Truthiness: `if (sub)`, `!sub`, `sub && ...`.
    if (
      /(?:\b(?:if|while)\s*\(|!|&&|\|\||\?)\s*$/.test(before) &&
      /^\s*(?:\)|&&|\|\||\?|;)/.test(after)
    ) {
      continue;
    }
    // Logged for the user.
    if (/\bconsole\.\w+\([^;\n]*$/.test(lineBefore)) continue;
    // A guarded hand-off: `if (sub === 'a') run(sub)`.
    if (
      /[A-Za-z_$][\w$]*\s*\(\s*(?:[^()\n]*,\s*)?$/.test(lineBefore) &&
      /^\s*[,)]/.test(after) &&
      literalGuard.test(lineBefore)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

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
  // Every remaining use of the token must be one of the closed shapes. This
  // is what catches `COMMANDS.has(sub)` / `COMMANDS.get(sub)` (a Map/Set
  // dispatch whose key set lives in data), `sub.startsWith('db:')`, and an
  // unguarded `dispatch(sub)` -- each used to resolve as the closed set of
  // whatever literals happened to be compared elsewhere (often just {help}).
  if (!everyUseIsClosed(code, tok)) return null;

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
  // file. The block ends at its matching brace, counted on the `code` view
  // (string bodies blanked, so a `}` inside a string cannot close it). The two
  // views are the same length, so the offsets carry across.
  const switchRe = new RegExp(`switch\\s*\\(\\s*${tok}\\s*\\)\\s*\\{`, 'g');
  for (const m of code.matchAll(switchRe)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let end = start;
    while (end < code.length && depth > 0) {
      if (code[end] === '{') depth++;
      else if (code[end] === '}') depth--;
      end++;
    }
    const block = literals.slice(start, end);
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
  let abs = resolveEntry(projectRoot, projectRoot, entry);
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
    abs = resolveEntry(projectRoot, path.dirname(abs), target);
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

/** A subcommand is a bareword: not a flag, path, assignment, or filename. */
const SUBCOMMAND_SHAPE = /^[a-z][a-z0-9:_-]*$/i;

/** Fence info strings whose body is shell to run. */
const SHELL_FENCES = new Set(['bash', 'sh', 'shell', 'zsh']);
/** Fence info strings whose body is a transcript: only `$ `-prompted lines run. */
const SESSION_FENCES = new Set(['console', 'shell-session', 'sh-session']);

/** `$ cmd` -- a shell prompt. `>` is NOT a prompt: outside a fence it is a blockquote. */
const PROMPT = /^\s*\$\s+/;

/** Node flags that take a separate value before the script path. */
const NODE_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
]);

/**
 * Flags that by near-universal convention take no value, so the bareword
 * after one is the subcommand, not the flag's argument. Deliberately short:
 * any flag missing here only makes the following bareword ambiguous (accepted
 * when known, else silent), never a false finding.
 */
const BOOLEAN_FLAGS = new Set([
  '-v',
  '-q',
  '-y',
  '--verbose',
  '--quiet',
  '--silent',
  // Not --debug: many CLIs give it a value (`--debug <namespace>`).
  '--json',
  '--yes',
  '--force',
  '--dry-run',
]);

export interface FindBinOptions {
  /**
   * The project's `package.json#name`, so `npx <name>[@version] <sub>`
   * resolves to this package's bin even when the bin is named differently.
   */
  packageName?: string;
  /** The owned bins with their entries, so `node <entry> <sub>` resolves. */
  bins?: OwnedBin[];
  /**
   * The resolved subcommand set of a bin, or null. Supplying it lets the
   * scanner use evidence it otherwise cannot: an untagged fence with no `$ `
   * prompts is read as commands only when some line in it names a KNOWN
   * subcommand (otherwise it may be sample output), and a bareword after a
   * value-less flag (`--format json`) is accepted only when it is known.
   */
  knownFor?: (bin: string) => Set<string> | null;
}

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
 *
 * Fence and HTML-comment structure comes from utils/markdown.ts (via
 * fenceBlocks), not a tracker of its own: the hand-rolled one here let a fence
 * line containing `<!--` swallow the closing fence and everything after it.
 *
 * Which lines count as commands:
 *  - `bash`/`sh`/`shell`/`zsh` fences: every non-comment line.
 *  - `console`/`shell-session` fences: only `$ `-prompted lines; the rest is
 *    output.
 *  - untagged fences: the `$ `-prompted lines when there are any; otherwise
 *    every line, but only if some line names a known subcommand (needs
 *    `options.knownFor`) -- an unprompted untagged block is as often sample
 *    output ("mytool started on port 3000") as it is commands. Even then a
 *    line with an unknown subcommand is kept only when it reads as a command
 *    (see readsAsCommand).
 *  - prose: `$ `-prompted lines and inline code spans, after blanking any
 *    self-contained `<!-- ... -->` on the line.
 */
export function findBinInvocations(
  content: string,
  binNames: Set<string>,
  options: FindBinOptions = {},
): BinInvocation[] {
  if (binNames.size === 0) return [];
  const out: BinInvocation[] = [];
  const lines = content.split('\n');
  const comment = htmlCommentLineMask(lines);
  const nonProse = nonProseLineMask(lines);
  const blocks = fenceBlocks(lines);

  const tryCandidate = (candidate: string, line: number, sink: BinInvocation[]) => {
    const hit = matchBinInvocation(candidate, binNames, options);
    if (hit) sink.push({ ...hit, cmd: candidate, line: line + 1 });
  };

  for (const b of blocks) {
    const lang = (b.info.split(/\s+/)[0] ?? '').toLowerCase();
    const body: number[] = [];
    for (let i = b.open + 1; i < b.close; i++) body.push(i);

    if (SHELL_FENCES.has(lang)) {
      for (const i of body) {
        const trimmed = lines[i].trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
        tryCandidate(trimmed.replace(PROMPT, ''), i, out);
      }
      continue;
    }
    if (!SESSION_FENCES.has(lang) && lang !== '') continue;

    const prompted = body.filter((i) => PROMPT.test(lines[i]));
    if (prompted.length > 0 || SESSION_FENCES.has(lang)) {
      for (const i of prompted) tryCandidate(lines[i].trim().replace(PROMPT, ''), i, out);
      continue;
    }
    // Untagged and unprompted: commands only on evidence.
    const knownFor = options.knownFor;
    if (!knownFor) continue;
    const hits: BinInvocation[] = [];
    for (const i of body) {
      const trimmed = lines[i].trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      tryCandidate(trimmed, i, hits);
    }
    if (!hits.some((h) => knownFor(h.bin)?.has(h.sub))) continue;
    // A known line proves the block holds a command, not that every line is
    // one: the rest may be its output ("mytool listening on port 3000").
    out.push(...hits.filter((h) => readsAsCommand(h, knownFor(h.bin))));
  }

  for (let i = 0; i < lines.length; i++) {
    // nonProse covers fenced lines (delimiters included) and comment lines.
    if (nonProse[i] || comment[i]) continue;
    // A self-contained `<!-- ... -->` leaves its line prose; blank the comment
    // itself so a command quoted inside it is not read.
    const line = stripInlineHtmlComments(lines[i]);
    if (PROMPT.test(line)) tryCandidate(line.trim().replace(PROMPT, ''), i, out);
    for (const span of inlineCodeSpans(line)) tryCandidate(span.content.trim(), i, out);
  }

  return out.sort((a, b) => a.line - b.line);
}

/**
 * Whether a line of an unprompted untagged fence reads as an invocation rather
 * than output that happens to start with the bin name. Known subcommands
 * always do. An unknown one does when it is a near-miss of a known name (a
 * typo, the case the rule exists for) or when nothing but flags follows it
 * (`mytool doctor --json`); trailing barewords ("listening on port 3000")
 * read as a sentence, so the line is left alone.
 */
function readsAsCommand(inv: BinInvocation, known: Set<string> | null): boolean {
  if (!known) return false;
  if (known.has(inv.sub)) return true;
  if (
    closestMatch(inv.sub, known, {
      ignoreCase: true,
      maxDistance: Math.max(2, Math.floor(inv.sub.length * 0.3)),
    })
  ) {
    return true;
  }
  const tokens = inv.cmd.split(/\s+/);
  const at = tokens.indexOf(inv.sub, 1);
  return at >= 0 && tokens.slice(at + 1).every((t) => t.startsWith('-'));
}

function unquote(t: string): string {
  return t.replace(/^["']|["']$/g, '');
}

/** `@scope/name@1.2.3` -> `@scope/name`; `name@latest` -> `name`. */
function packageSpecName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at > 0 ? spec.slice(0, at) : spec;
}

/** Normalize a path for comparing a documented script path with a bin entry. */
function normalizeEntry(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(BIN_EXT, '');
}

function matchBinInvocation(
  candidate: string,
  binNames: Set<string>,
  options: FindBinOptions,
): { bin: string; sub: string } | null {
  // Only the FIRST command on the line is considered; `foo && bar baz` is two
  // commands and the second is analysed on its own terms elsewhere.
  let s = candidate.trim();
  const stop = s.search(/&&|\|\||[;|]/);
  if (stop >= 0) s = s.slice(0, stop).trim();

  let tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) tokens = tokens.slice(1);
  const stripped = stripWrapperTokens(tokens);
  tokens = stripped.rest;
  if (tokens.length < 2) return null;

  const head = unquote(tokens[0]);
  let bin: string | null = null;
  let argStart = 1;

  if (stripped.packageRunner) {
    // `npx <pkg>[@version]` names a PACKAGE, whose bin may be named differently.
    const pkg = packageSpecName(head);
    const unscoped = pkg.slice(pkg.lastIndexOf('/') + 1);
    if (options.packageName && pkg === options.packageName) {
      if (binNames.size === 1) bin = [...binNames][0];
      else if (binNames.has(unscoped)) bin = unscoped;
    } else if (!pkg.startsWith('@') && binNames.has(unscoped)) {
      bin = unscoped;
    }
    // Some other package (`npx @other/name`, `npx other@1.2`): its bin is not ours.
    if (!bin && (pkg !== head || pkg.startsWith('@'))) return null;
  }
  if (!bin) {
    const name = commandNameOf(head);
    if (name && binNames.has(name)) bin = name;
  }
  if (!bin && commandNameOf(head) === 'node' && options.bins) {
    // `node dist/index.js <sub>` -- the script path IS one of our bin entries.
    let i = 1;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (!tokens[i].includes('=') && NODE_VALUE_FLAGS.has(tokens[i])) i++;
      i++;
    }
    const script = tokens[i] === undefined ? '' : normalizeEntry(unquote(tokens[i]));
    const owner = script ? options.bins.find((b) => normalizeEntry(b.entry) === script) : undefined;
    if (owner && binNames.has(owner.name)) {
      bin = owner.name;
      argStart = i + 1;
    }
  }
  if (!bin) return null;

  // A flag with no `=` may take the next bareword as its value
  // (`mytool --format json install`), so after one the bareword is not
  // necessarily the subcommand. Accept it only when it is a known name --
  // unless the flag is a conventional boolean (BOOLEAN_FLAGS, `--no-*`), which
  // takes no value, so `mytool --verbose doctor` still reaches `doctor`.
  let afterBareFlag = false;
  for (const raw of tokens.slice(argStart)) {
    if (raw === '--') return null; // everything after is positional
    if (raw.startsWith('-')) {
      afterBareFlag = !raw.includes('=') && !BOOLEAN_FLAGS.has(raw) && !raw.startsWith('--no-');
      continue;
    }
    const t = unquote(raw);
    if (!SUBCOMMAND_SHAPE.test(t)) return null; // a path/arg, not a subcommand
    if (afterBareFlag) return options.knownFor?.(bin)?.has(t) ? { bin, sub: t } : null;
    return { bin, sub: t };
  }
  return null;
}
