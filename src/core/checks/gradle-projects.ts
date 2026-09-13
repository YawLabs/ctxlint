import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripBom } from '../../utils/fs.js';

/**
 * Static analysis behind `commands/gradle-project-not-found`.
 *
 * `./gradlew :server:test` names the project `:server` and the task `test`.
 * Gradle treats the LAST colon segment as the task and every earlier segment
 * as a project path, resolved one level at a time against the children of the
 * project matched so far (DefaultBuildTaskSelector.resolveProject). A project
 * segment that matches nothing fails the build before any task runs:
 *
 *   Cannot locate tasks that match ':sever:test' as project 'sever' not found
 *   in root project 'es'.
 *
 * Only the project part is checked. Task names are contributed by plugins at
 * configuration time and have no static ground truth; the project set does,
 * in `settings.gradle(.kts)` -- but only when that file can be read as a
 * CLOSED set. Settings scripts are programs: elasticsearch walks the file
 * system to include projects, androidx calls its own `includeProject(...)`
 * helper, and any settings plugin receives the `Settings` object and may
 * include or rename anything. So the reader is deliberately strict and
 * answers `null` (emit nothing) the moment it sees a construct that could add
 * or rename a project it cannot enumerate. A wrong "that project does not
 * exist" is worse than silence, because the reader's correct doc looks broken.
 *
 * Never executes Gradle. Configuring a real build to ask it runs arbitrary
 * build logic, needs a JDK and the network, and takes minutes.
 */

const SETTINGS_FILES = ['settings.gradle', 'settings.gradle.kts'];

/**
 * Settings plugins verified NOT to add or rename projects. Anything else in a
 * settings `plugins {}` block makes the set open: a settings plugin receives
 * the full `Settings` object (for example `org.gradlex.java-module-dependencies`
 * calls `settings.include(...)` for every `module-info.java` it finds, and the
 * Micronaut shared settings plugin renames every project).
 */
const BENIGN_SETTINGS_PLUGINS = new Set([
  'com.gradle.develocity',
  'com.gradle.enterprise',
  'com.gradle.common-custom-user-data-gradle-plugin',
  'org.gradle.toolchains.foojay-resolver',
  'org.gradle.toolchains.foojay-resolver-convention',
]);

/**
 * Identifiers that hand the settings object, or arbitrary code, to something
 * we cannot read. `apply` is handled separately: `apply plugin: '<allowlisted>'`
 * is fine, `apply from:` and any other plugin are not. The Groovy dynamic
 * dispatch hooks are here because `settings.invokeMethod('include', ...)`
 * includes a project with no `include` token in sight.
 */
const OPEN_IDENTIFIERS = new Set([
  'pluginManager',
  'settingsEvaluated',
  'beforeSettings',
  'evaluate',
  'GroovyShell',
  'Eval',
  'ScriptEngineManager',
  'createProjectDescriptor',
  'classpath',
  'invokeMethod',
  'metaClass',
  'methodMissing',
  'setProperty',
]);

type Token =
  | { kind: 'ident'; text: string; line: number }
  | { kind: 'string'; text: string; interpolated: boolean; line: number }
  | { kind: 'punct'; text: string; line: number };

/** The statically enumerated project set of one Gradle build. */
export interface GradleProjectSet {
  /** Every project path, root excluded: `:a`, `:a:b`, ... */
  paths: Set<string>;
  /**
   * First-segment names that address another BUILD rather than a project:
   * included builds (dir basename, or a literal `name =` override) and
   * `buildSrc`. A task path starting with one of these is not checked.
   */
  builds: Set<string>;
  /** Settings file the set was read from, relative to the build root. */
  settingsFile: string;
}

/**
 * Find the Gradle build a context file's commands run against: the nearest
 * directory at or above the context file, bounded by the project root, that
 * holds a settings file. A nested independent build (koog's
 * `examples/simple-examples/`) therefore gets its own settings, not the root's.
 */
export function findGradleBuildRoot(contextFile: string, projectRoot: string): string | null {
  const root = path.resolve(projectRoot);
  let dir = path.dirname(path.resolve(contextFile));
  for (;;) {
    if (SETTINGS_FILES.some((f) => fs.existsSync(path.join(dir, f)))) return dir;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    const rel = path.relative(root, parent);
    if (parent === dir || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    dir = parent;
  }
}

/**
 * Read a build's project set from its settings file, or null when it is not
 * statically enumerable. Also null when there is no settings file or there
 * are two (Groovy and Kotlin side by side is ambiguous).
 */
export function readGradleProjectSet(buildRoot: string): GradleProjectSet | null {
  const present = SETTINGS_FILES.filter((f) => fs.existsSync(path.join(buildRoot, f)));
  if (present.length !== 1) return null;
  let source: string;
  try {
    source = stripBom(fs.readFileSync(path.join(buildRoot, present[0]), 'utf-8'));
  } catch {
    return null;
  }
  const parsed = parseSettings(source);
  if (!parsed) return null;
  if (isValidBuildSrc(path.join(buildRoot, 'buildSrc'))) parsed.builds.add('buildSrc');
  return { ...parsed, settingsFile: present[0] };
}

/** Mirrors Gradle's BuildSrcDetector: a build file, a settings file, or any file under `src/`. */
function isValidBuildSrc(dir: string): boolean {
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  const markers = ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'];
  if (markers.some((m) => fs.existsSync(path.join(dir, m)))) return true;
  return fs.existsSync(path.join(dir, 'src'));
}

/**
 * Parse settings source into a project set, or null when open. Exported for
 * unit tests; production code goes through readGradleProjectSet.
 */
export function parseSettings(source: string): { paths: Set<string>; builds: Set<string> } | null {
  const tokens = tokenize(source);
  if (!tokens) return null;

  const paths = new Set<string>();
  const builds = new Set<string>();
  const renames: Array<{ from: string; to: string }> = [];
  // Brace stack: for each open `{`, whether its opener addresses a project
  // descriptor (`project(':a') {`, `with(project(':a')) {`, `children.each {`).
  // A bare `name = ...` inside such a block renames a project.
  const blocks: boolean[] = [];
  // Index just past the `pluginManagement {}` block, while inside it.
  let pluginManagementEnd = -1;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];

    if (t.kind === 'punct') {
      if (t.text === '{') blocks.push(openerAddressesProject(tokens, i));
      else if (t.text === '}') blocks.pop();
      continue;
    }
    // Groovy dynamic dispatch: `settings.'include'('a')` / `settings."$m"(...)`.
    if (t.kind === 'string') {
      const before = tokens[i - 1];
      if (before?.kind === 'punct' && (before.text === '.' || before.text === '?.')) return null;
      continue;
    }
    if (t.kind !== 'ident') continue;

    if (t.text === 'apply') {
      // Only `apply plugin: '<allowlisted>'` / `apply(plugin = "<allowlisted>")`
      // is readable; `apply from:` runs a script, anything else a plugin.
      if (!appliesBenignPlugin(tokens, i)) return null;
      continue;
    }

    if (t.text === 'pluginManagement' && tokens[i + 1]?.text === '{') {
      pluginManagementEnd = Math.max(pluginManagementEnd, skipBalanced(tokens, i + 1));
      continue;
    }

    const prev = tokens[i - 1];
    const receiverDot = prev?.kind === 'punct' && (prev.text === '.' || prev.text === '?.');
    const receiver = receiverDot ? tokens[i - 2] : undefined;

    if (OPEN_IDENTIFIERS.has(t.text)) {
      // `System.setProperty(...)` sets a JVM property, not a Groovy property.
      const systemProperty =
        t.text === 'setProperty' && receiver?.kind === 'ident' && receiver.text === 'System';
      if (!systemProperty) return null;
    }

    if (t.text === 'include' || t.text === 'includeFlat') {
      // `copy { include '**' }` / `fileTree.include(...)` are PatternFilterable,
      // not Settings. A receiver other than `settings` means a pattern filter;
      // without a receiver we must assume Settings, and literal arguments are
      // harmless either way (a superset of names only suppresses findings).
      if (receiverDot && !(receiver?.kind === 'ident' && receiver.text === 'settings')) continue;
      const args = literalArguments(tokens, i + 1);
      if (!args) return null;
      for (const arg of args) {
        if (t.text === 'includeFlat') paths.add(`:${arg}`);
        else addIncludePath(paths, arg);
      }
      continue;
    }

    if (t.text === 'includeBuild') {
      if (receiverDot) return null;
      const args = literalArguments(tokens, i + 1, 1);
      if (!args || args.length !== 1) return null;
      const base = path.posix.basename(args[0].replace(/\\/g, '/').replace(/\/+$/, ''));
      if (!base || base === '.' || base === '..') return null;
      builds.add(base);
      // `includeBuild('dir') { name = 'other' }` -- add the override too.
      const override = includeBuildNameOverride(tokens, i + 1);
      if (override === null) return null;
      if (override) builds.add(override);
      continue;
    }

    if (t.text === 'plugins' && tokens[i + 1]?.kind === 'punct' && tokens[i + 1].text === '{') {
      // Inside `pluginManagement {}` a plugins block only pins versions; at top
      // level it APPLIES settings plugins, each of which could include projects.
      if (i >= pluginManagementEnd && !pluginsBlockIsBenign(tokens, i + 1)) return null;
      i = skipBalanced(tokens, i + 1) - 1;
      continue;
    }

    if (t.text === 'name' || t.text === 'setName') {
      const next = tokens[i + 1];
      const isAssign = next?.kind === 'punct' && next.text === '=';
      const isSetter = t.text === 'setName' && next?.kind === 'punct' && next.text === '(';
      if (!isAssign && !isSetter) continue;

      if (receiverDot) {
        if (receiver?.kind === 'ident' && receiver.text === 'rootProject') continue; // root path is always ':'
        const target = literalProjectCall(tokens, i - 2);
        const value = isAssign
          ? literalValue(tokens, i + 2)
          : literalArguments(tokens, i + 1, 1)?.[0];
        if (!target || !value) return null;
        renames.push({ from: normalizeProjectPath(target), to: value });
        continue;
      }
      // A bare `name =` renames only inside a project-descriptor block; in a
      // `maven { name = ... }` repository block it is harmless.
      if (blocks.includes(true)) return null;
    }
  }

  // Literal renames: `project(':a').name = 'b'` moves `:a` (and descendants
  // registered before the rename) to `:b`. Keep the old paths too -- whether
  // the rename ran before or after a later include is order-dependent, and a
  // superset can only suppress findings.
  for (const { from, to } of renames) {
    const parent = from.slice(0, from.lastIndexOf(':'));
    const moved = `${parent}:${to}`;
    for (const p of [...paths]) {
      if (p === from) paths.add(moved);
      else if (p.startsWith(`${from}:`)) paths.add(moved + p.slice(from.length));
    }
  }

  return { paths, builds };
}

/** `include 'a:b:c'` registers `:a`, `:a:b` and `:a:b:c` (DefaultSettings.include). */
function addIncludePath(paths: Set<string>, arg: string): void {
  const segments = arg.replace(/^:/, '').split(':');
  if (segments.some((s) => s.length === 0)) return;
  let acc = '';
  for (const s of segments) {
    acc += `:${s}`;
    paths.add(acc);
  }
}

function normalizeProjectPath(p: string): string {
  return p.startsWith(':') ? p : `:${p}`;
}

/**
 * Collect the string-literal arguments of a call starting at `start`, in
 * either call form: `include("a", "b")` or the Groovy command form
 * `include 'a', 'b'` (continuing across a newline after a comma). List
 * wrappers `['a']`, `listOf("a")`, `arrayOf("a")` and a `*` spread are
 * unwrapped. Returns null when any argument is not a plain literal.
 */
function literalArguments(tokens: Token[], start: number, max = Infinity): string[] | null {
  const out: string[] = [];
  let i = start;
  const first = tokens[i];
  if (!first) return null;
  const parenthesized = first.kind === 'punct' && first.text === '(';
  if (parenthesized) i++;
  const line = first.line;

  for (;;) {
    let t = tokens[i];
    if (!t) return parenthesized ? null : out.length ? out : null;
    if (parenthesized && t.kind === 'punct' && t.text === ')') return out;

    // Unwrap `*listOf(...)`, `arrayOf(...)`, `[...]`.
    if (t.kind === 'punct' && t.text === '*') t = tokens[++i];
    if (
      t &&
      t.kind === 'ident' &&
      ['listOf', 'arrayOf', 'setOf'].includes(t.text) &&
      tokens[i + 1]?.text === '('
    ) {
      const inner = literalArguments(tokens, i + 1);
      if (!inner) return null;
      out.push(...inner);
      i = skipBalanced(tokens, i + 1);
    } else if (t && t.kind === 'punct' && t.text === '[') {
      const inner = literalList(tokens, i);
      if (!inner) return null;
      out.push(...inner.values);
      i = inner.next;
    } else if (t && t.kind === 'string' && !t.interpolated) {
      out.push(t.text);
      i++;
    } else if (
      t &&
      t.kind === 'ident' &&
      t.text === 'file' &&
      tokens[i + 1]?.text === '(' &&
      literalValue(tokens, i + 2) !== null &&
      tokens[i + 3]?.text === ')'
    ) {
      out.push(literalValue(tokens, i + 2) as string);
      i += 4;
    } else {
      return null;
    }
    if (out.length > max) return null;

    const sep = tokens[i];
    if (sep?.kind === 'punct' && sep.text === ',') {
      i++;
      continue;
    }
    if (parenthesized) {
      return sep?.kind === 'punct' && sep.text === ')' ? out : null;
    }
    // Command form ends at the end of the statement: the next token must be on
    // a later line or a statement separator, never a continuation like `+ x`.
    if (!sep || sep.line > (tokens[i - 1]?.line ?? line) || sep.text === ';' || sep.text === '}') {
      return out;
    }
    return null;
  }
}

function literalList(tokens: Token[], start: number): { values: string[]; next: number } | null {
  const values: string[] = [];
  let i = start + 1;
  for (;;) {
    const t = tokens[i];
    if (!t) return null;
    if (t.kind === 'punct' && t.text === ']') return { values, next: i + 1 };
    if (t.kind !== 'string' || t.interpolated) return null;
    values.push(t.text);
    i++;
    const sep = tokens[i];
    if (sep?.kind === 'punct' && sep.text === ',') i++;
  }
}

/** Index just past the balanced group opening at `start` (`(`, `[` or `{`). */
function skipBalanced(tokens: Token[], start: number): number {
  const open = tokens[start].text;
  const close = open === '(' ? ')' : open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'punct') continue;
    if (t.text === open) depth++;
    else if (t.text === close && --depth === 0) return i + 1;
  }
  return tokens.length;
}

/** A single non-interpolated string literal at `i`, or null. */
function literalValue(tokens: Token[], i: number): string | null {
  const t = tokens[i];
  return t?.kind === 'string' && !t.interpolated ? t.text : null;
}

/**
 * For a `.name` receiver ending at `end` (the token before the dot), return
 * the literal path of `project('x')` / `findProject('x')` (optionally followed
 * by `!!`), or null.
 */
function literalProjectCall(tokens: Token[], end: number): string | null {
  let i = end;
  while (tokens[i]?.kind === 'punct' && tokens[i].text === '!') i--;
  if (tokens[i]?.text !== ')') return null;
  const lit = tokens[i - 1];
  const open = tokens[i - 2];
  const fn = tokens[i - 3];
  if (lit?.kind !== 'string' || lit.interpolated) return null;
  if (open?.text !== '(' || fn?.kind !== 'ident') return null;
  if (fn.text !== 'project' && fn.text !== 'findProject') return null;
  // A receiver before `project(...)` (`gradle.rootProject.project(...)`) is
  // still the settings descriptor tree; nothing to check.
  return lit.text;
}

/**
 * The literal `name = '...'` inside a trailing `{}` configuring an included
 * build. Returns '' when there is no block or no name assignment, null when
 * the block assigns a non-literal name.
 */
function includeBuildNameOverride(tokens: Token[], argsStart: number): string | null {
  let i = argsStart;
  if (tokens[i]?.text === '(') i = skipBalanced(tokens, i);
  else while (tokens[i]?.kind === 'string') i++;
  if (tokens[i]?.text !== '{') return '';
  const end = skipBalanced(tokens, i);
  for (let j = i + 1; j < end; j++) {
    if (tokens[j].kind === 'ident' && tokens[j].text === 'name' && tokens[j + 1]?.text === '=') {
      return literalValue(tokens, j + 2);
    }
  }
  return '';
}

/**
 * True when every plugin applied in a settings `plugins {}` block is either
 * `apply false` or on the verified-benign allowlist.
 */
function pluginsBlockIsBenign(tokens: Token[], braceIndex: number): boolean {
  const end = skipBalanced(tokens, braceIndex);
  for (let j = braceIndex + 1; j < end - 1; j++) {
    const t = tokens[j];
    if (t.kind !== 'ident') continue;
    if (t.text === 'id') {
      const id = literalValue(tokens, tokens[j + 1]?.text === '(' ? j + 2 : j + 1);
      if (!id) return false;
      // `apply false` (Groovy) / `apply(false)` / `apply false` (Kotlin) on the same statement.
      let applyFalse = false;
      for (let k = j + 1; k < end - 1 && tokens[k].line === t.line; k++) {
        if (tokens[k].kind === 'ident' && tokens[k].text === 'apply') {
          const n = tokens[k + 1]?.text === '(' ? tokens[k + 2] : tokens[k + 1];
          applyFalse = n?.kind === 'ident' && n.text === 'false';
        }
      }
      if (!applyFalse && !BENIGN_SETTINGS_PLUGINS.has(id)) return false;
    } else if (!['version', 'apply', 'false'].includes(t.text)) {
      // Anything else (`kotlin("jvm")`, `` `kotlin-dsl` ``, a catalog `alias(...)`
      // whose id we cannot resolve) is a plugin we cannot vet.
      return false;
    }
  }
  return true;
}

/**
 * Is the `apply` at `i` either a verified-benign `apply plugin:` or the
 * `apply false` / `apply(false)` suffix of a plugins-block entry? Plugins
 * blocks are skipped wholesale, so the latter only reaches here outside one.
 */
function appliesBenignPlugin(tokens: Token[], i: number): boolean {
  let j = i + 1;
  if (tokens[j]?.text === '(') j++;
  const key = tokens[j];
  const sep = tokens[j + 1];
  if (key?.kind !== 'ident' || key.text !== 'plugin') return false;
  if (sep?.text !== ':' && sep?.text !== '=') return false;
  const id = literalValue(tokens, j + 2);
  return id !== null && BENIGN_SETTINGS_PLUGINS.has(id);
}

/** Does the statement that opens the `{` at `braceIndex` address a project descriptor? */
function openerAddressesProject(tokens: Token[], braceIndex: number): boolean {
  const line = tokens[braceIndex].line;
  for (let j = braceIndex - 1; j >= 0 && tokens[j].line === line; j--) {
    const t = tokens[j];
    if (
      t.kind === 'ident' &&
      [
        'project',
        'findProject',
        'children',
        'getChildren',
        'allprojects',
        'subprojects',
        'descendants',
        'rootProject',
        'projectDescriptors',
      ].includes(t.text)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A small Groovy/Kotlin lexer: identifiers, string literals (with an
 * interpolation flag) and punctuation, with comments removed. Returns null on
 * a construct it cannot lex reliably (an unterminated string or comment), so
 * the caller treats the file as open.
 */
function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return null;
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const triple = src.startsWith(c.repeat(3), i);
      const delim = triple ? c.repeat(3) : c;
      const startLine = line;
      let j = i + delim.length;
      let text = '';
      let interpolated = false;
      let closed = false;
      while (j < n) {
        if (src.startsWith(delim, j)) {
          closed = true;
          j += delim.length;
          break;
        }
        const ch = src[j];
        if (ch === '\n') {
          if (!triple) return null;
          line++;
        }
        if (ch === '\\' && j + 1 < n) {
          text += src[j + 1];
          j += 2;
          continue;
        }
        // Groovy single-quoted strings never interpolate; Groovy/Kotlin double
        // quotes and Kotlin raw strings do.
        if (ch === '$' && c === '"') {
          interpolated = true;
          if (src[j + 1] === '{') {
            const end = skipTemplate(src, j + 1);
            if (end < 0) return null;
            for (let k = j; k < end; k++) if (src[k] === '\n') line++;
            j = end;
            continue;
          }
        }
        text += ch;
        j++;
      }
      if (!closed) return null;
      tokens.push({ kind: 'string', text, interpolated, line: startLine });
      i = j;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(src[j])) j++;
      tokens.push({ kind: 'ident', text: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end < 0) return null;
      tokens.push({ kind: 'ident', text: src.slice(i + 1, end), line });
      i = end + 1;
      continue;
    }
    if (c === '?' && src[i + 1] === '.') {
      tokens.push({ kind: 'punct', text: '?.', line });
      i += 2;
      continue;
    }
    if (c === '=' && src[i + 1] === '=') {
      tokens.push({ kind: 'punct', text: '==', line });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'punct', text: c, line });
    i++;
  }
  return tokens;
}

/** Index just past the `}` closing a `${` template whose `{` is at `open`. */
function skipTemplate(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return j + 1;
    else if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, j + 1);
      if (end < 0) return -1;
      j = end;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Name matching: a port of org.gradle.util.internal.NameMatcher.
// ---------------------------------------------------------------------------

/** Java's `\p{Punct}` (POSIX, ASCII only). */
const PUNCT = '[!"#$%&\'()*+,\\-./:;<=>?@\\[\\\\\\]^_`{|}~]';
const LOWER = '\\p{Lowercase}';
const UPPER = '\\p{Uppercase}';
const CAMEL_BOUNDARY = new RegExp(`((^|${PUNCT})${LOWER}+)|((${UPPER}|[0-9])${LOWER}*)`, 'gu');
const KEBAB_BOUNDARY = new RegExp(`((^|${PUNCT})${LOWER}+)|(${UPPER}${LOWER}*)`, 'gu');

function quote(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function patternForName(
  name: string,
  boundary: RegExp,
  add: (pos: number, part: string) => string,
): string {
  let out = '';
  let pos = 0;
  boundary.lastIndex = 0;
  for (const m of name.matchAll(boundary)) {
    const start = m.index ?? 0;
    if (start > pos) out += quote(name.slice(pos, start));
    out += add(pos, m[0]);
    pos = start + m[0].length;
  }
  if (pos < name.length) out += quote(name.slice(pos));
  return out;
}

/**
 * Resolve `pattern` against `items` the way Gradle does. Returns the unique
 * match, `'ambiguous'` when several candidates match, or null when nothing
 * matches at all. The linter only reports the null case: an ambiguous
 * abbreviation also fails the build, but adding one project can flip it, so
 * it is not a stable finding.
 *
 * JavaScript's `u`+`i` flags fold property classes slightly more generously
 * than Java's CASE_INSENSITIVE|UNICODE_CASE. That can only ADD matches, which
 * turns a would-be finding into silence, never the reverse.
 */
export function matchGradleName(
  pattern: string,
  items: Iterable<string>,
): string | 'ambiguous' | null {
  const list = [...items];
  if (list.includes(pattern)) return pattern;
  if (!pattern) return null;

  const camel = patternForName(
    pattern,
    CAMEL_BOUNDARY,
    (_pos, part) => `${quote(part)}[${LOWER}]*`,
  );
  const kebab = patternForName(
    pattern,
    KEBAB_BOUNDARY,
    (pos, part) => `${pos > 0 ? '-' : ''}${quote(part.toLowerCase())}[${LOWER}0-9]*`,
  );
  const camelFull = new RegExp(`^(?:${camel})$`, 'u');
  const camelPrefix = new RegExp(`^(?:${camel})`, 'u');
  const camelPrefixCi = new RegExp(`^(?:${camel})`, 'iu');
  const kebabFull = new RegExp(`^(?:${kebab})$`, 'u');
  const kebabPrefix = new RegExp(`^(?:${kebab})[${LOWER}0-9-]*$`, 'u');

  const ci: string[] = [];
  const camelMatches: string[] = [];
  const prefixMatches: string[] = [];
  const ciCamel: string[] = [];
  const kebabMatches: string[] = [];
  const kebabPrefixMatches: string[] = [];
  const upper = pattern.toUpperCase();
  for (const c of list) {
    if (c.toUpperCase() === upper) ci.push(c);
    if (camelFull.test(c)) camelMatches.push(c);
    if (camelPrefix.test(c)) prefixMatches.push(c);
    if (camelPrefixCi.test(c)) ciCamel.push(c);
    if (kebabFull.test(c)) kebabMatches.push(c);
    if (kebabPrefix.test(c)) kebabPrefixMatches.push(c);
  }

  const matches = new Set<string>();
  if (ci.length) ci.forEach((m) => matches.add(m));
  else if (camelMatches.length) camelMatches.forEach((m) => matches.add(m));
  else if (prefixMatches.length) prefixMatches.forEach((m) => matches.add(m));
  else if (!kebabMatches.length && !kebabPrefixMatches.length)
    ciCamel.forEach((m) => matches.add(m));
  if (kebabMatches.length) kebabMatches.forEach((m) => matches.add(m));
  else kebabPrefixMatches.forEach((m) => matches.add(m));

  if (matches.size === 1) return [...matches][0];
  return matches.size > 1 ? 'ambiguous' : null;
}

// ---------------------------------------------------------------------------
// Command-line parsing.
// ---------------------------------------------------------------------------

/** Heads that invoke Gradle against the build in the working directory. */
const GRADLE_HEAD = /^(?:\.[\\/])?gradlew(?:\.bat)?$|^gradle$/;

/**
 * Options that consume the following token as their value (StartParameterBuildOptions,
 * LoggingConfigurationBuildOptions, ParallelismBuildOptions, DaemonBuildOptions,
 * BuildLayoutParametersBuildOptions and DefaultCommandLineConverter, Gradle 8.14-9.7).
 */
const VALUE_OPTIONS = new Set([
  '-x',
  '--exclude-task',
  '-g',
  '--gradle-user-home',
  '--project-cache-dir',
  '--console',
  '--console-unicode',
  '--warning-mode',
  '--max-workers',
  '--priority',
  '--develocity-url',
  '--develocity-plugin-version',
  '--write-verification-metadata',
  '-F',
  '--dependency-verification',
  '--update-locks',
  '--configuration-cache-problems',
  '-D',
  '--system-prop',
  '-P',
  '--project-prop',
]);

/**
 * Options that change WHICH build, settings file or project set the command
 * runs against. Any of them makes the invocation uncheckable from the context
 * file alone: `-p core` runs in another directory, `--include-build x` adds a
 * build no settings file shows, an init script can include projects in
 * `beforeSettings`.
 */
const RETARGET_OPTIONS = new Set([
  '-p',
  '--project-dir',
  '-c',
  '--settings-file',
  '-b',
  '--build-file',
  '--include-build',
  '-I',
  '--init-script',
]);

/** Built-in boolean long options; everything else long-form is a task option that may take a value. */
const BOOLEAN_LONG_OPTIONS = new Set([
  '--rerun-tasks',
  '--profile',
  '--continue',
  '--no-continue',
  '--offline',
  '--refresh-dependencies',
  '--dry-run',
  '--continuous',
  '--no-rebuild',
  '--configure-on-demand',
  '--no-configure-on-demand',
  '--build-cache',
  '--no-build-cache',
  '--watch-fs',
  '--no-watch-fs',
  '--scan',
  '--no-scan',
  '--write-locks',
  '--refresh-keys',
  '--export-keys',
  '--configuration-cache',
  '--no-configuration-cache',
  '--property-upgrade-report',
  '--problems-report',
  '--no-problems-report',
  '--task-graph',
  '--quiet',
  '--warn',
  '--info',
  '--debug',
  '--stacktrace',
  '--full-stacktrace',
  '--non-interactive',
  '--parallel',
  '--no-parallel',
  '--daemon',
  '--no-daemon',
  '--foreground',
  '--stop',
  '--status',
  '--help',
  '--version',
  '--show-version',
]);

/** A task path token: `:a:b:task` or `a:b:task` with plain name characters only. */
const TASK_PATH = /^:?[\w.-]+(?::[\w.-]+)+$|^:[\w.-]+$/;

/**
 * Names documentation uses as stand-ins for a real project. They carry no
 * marker (`<module>` and `{module}` fail TASK_PATH already), so they look like
 * real project names: ktor writes `:module-name:jvmTest` fifteen times,
 * duckduckgo `:my-feature-impl:testDebugUnitTest`.
 */
const PLACEHOLDER_SEGMENT =
  /^(?:module|project|subproject|submodule|component|feature)(?:[-_]?(?:name|path|id))?$|^(?:my|your|some|example|sample)[-_]|^(?:foo|bar|baz|xxx|name)$/i;

/** One project reference found in a Gradle command. */
export interface GradleProjectRef {
  /** The task path as written, e.g. `:server:test`. */
  token: string;
  /** Project path segments, task excluded: `['server']`. */
  segments: string[];
  /** Whether the path is absolute (leading colon). */
  absolute: boolean;
}

/**
 * Pull checkable project references out of a Gradle invocation. Returns null
 * when the command is not a Gradle invocation or retargets the build; an
 * empty array when it is one but names no project.
 */
export function gradleProjectRefs(cmd: string): GradleProjectRef[] | null {
  const tokens = shellWords(cmd);
  if (!tokens || tokens.length === 0 || !GRADLE_HEAD.test(tokens[0])) return null;

  const refs: GradleProjectRef[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('-')) {
      const bare = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
      if (RETARGET_OPTIONS.has(bare)) return null;
      if (tok.includes('=')) continue;
      if (VALUE_OPTIONS.has(tok)) {
        i++;
        continue;
      }
      // An unknown long option is a task option (`--tests Foo`, `--dependency
      // g:a`). Its value may be a separate token, and may contain a colon, so
      // skip the next word unless it is itself an option.
      if (tok.startsWith('--') && !BOOLEAN_LONG_OPTIONS.has(tok)) {
        if (tokens[i + 1] && !tokens[i + 1].startsWith('-')) i++;
      }
      continue;
    }
    if (!TASK_PATH.test(tok)) continue;
    const absolute = tok.startsWith(':');
    const segments = (absolute ? tok.slice(1) : tok).split(':');
    const projectSegments = segments.slice(0, -1);
    if (projectSegments.length === 0) continue;
    if (projectSegments.some((s) => PLACEHOLDER_SEGMENT.test(s))) continue;
    refs.push({ token: tok, segments: projectSegments, absolute });
  }
  return refs;
}

/**
 * Split a command into words, honoring single and double quotes, dropping a
 * trailing `# comment`, and stopping at the first control operator (`&&`,
 * `||`, `|`, `;`) or redirection. Null on an unterminated quote.
 */
export function shellWords(cmd: string): string[] | null {
  const words: string[] = [];
  let buf = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(buf);
      buf = '';
      inWord = false;
      continue;
    }
    if (!inWord && ch === '#') break;
    // `<module>` in a doc is a placeholder, not an input redirection: keep a
    // `<...>` run that closes before the next space as part of the word.
    if (ch === '<') {
      const close = cmd.slice(i).search(/>|\s/);
      if (close > 1 && cmd[i + close] === '>') {
        buf += cmd.slice(i, i + close + 1);
        i += close;
        inWord = true;
        continue;
      }
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '>' || ch === '<') break;
    buf += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(buf);
  return words;
}

/**
 * Resolve a project reference against a project set. Returns the unresolved
 * segment's full path (`:connect:mirrorz`) when a segment matches nothing, or
 * null when the path resolves, is ambiguous, or enters another build.
 */
export function unresolvedGradleProject(
  ref: GradleProjectRef,
  set: GradleProjectSet,
): string | null {
  let current = '';
  for (let depth = 0; depth < ref.segments.length; depth++) {
    const seg = ref.segments[depth];
    const children = childNames(set.paths, current);
    if (depth === 0) {
      // Included builds and buildSrc are addressed like children of the root.
      const match = matchGradleName(seg, [...children, ...set.builds]);
      if (match === null) return `:${seg}`;
      if (match === 'ambiguous' || set.builds.has(match)) return null;
      current = `:${match}`;
      continue;
    }
    const match = matchGradleName(seg, children);
    if (match === null) return `${current}:${seg}`;
    if (match === 'ambiguous') return null;
    current = `${current}:${match}`;
  }
  return null;
}

/** Direct child names of `parent` (`''` for the root) in a path set. */
function childNames(paths: Set<string>, parent: string): Set<string> {
  const out = new Set<string>();
  const prefix = `${parent}:`;
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (rest && !rest.includes(':')) out.add(rest);
  }
  return out;
}
