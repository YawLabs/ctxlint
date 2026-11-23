import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { countTokens } from '../../utils/tokens.js';
import { stripBom } from '../../utils/fs.js';
import { claudeConfigDir, homeDir } from '../../utils/claude-home.js';
import {
  inlineCodeSpans,
  isFrontmatterFence,
  maskCodeSpans,
  nonProseLineMask,
  stripInlineHtmlComments,
} from '../../utils/markdown.js';
import { redactSecrets } from './content-secrets.js';
import { DEFAULT_TOKEN_THRESHOLDS, type TokenThresholds } from './tokens.js';
import type { ParsedContextFile, LintIssue, Section } from '../types.js';

// Files that Claude Code (and similar agents) load into every session by
// default -- the "always-loaded" tier. See docs/research/context-hierarchy.md
// Q2 for sources (code.claude.com/docs/en/memory). Each entry names the tool
// that loads it, because the aggregate budget is per tool: no session loads
// CLAUDE.md, GEMINI.md and .cursorrules together.
//
// Two match shapes:
//   bare basename -- matches at any depth (e.g. "CLAUDE.md" anywhere). Only
//                    the project-root copy is loaded every session; a nested
//                    one (packages/a/CLAUDE.md) loads when the agent works in
//                    that subtree, so the per-file checks still apply to it
//                    but the aggregate does not count it.
//   "parent/basename" suffix -- only matches when the file actually lives
//                                under that parent dir (handles generic names
//                                like "instructions.md" / "guidelines.md"
//                                that are tool-specific only inside .goose/ /
//                                .junie/, NOT in arbitrary docs/api/ paths)
const ALWAYS_LOADED_NAMES: ReadonlyArray<{ name: string; tool: string }> = [
  { name: 'CLAUDE.md', tool: 'Claude Code' },
  { name: 'CLAUDE.local.md', tool: 'Claude Code' },
  { name: 'AGENTS.md', tool: 'Codex' },
  { name: 'AGENTS.override.md', tool: 'Codex' },
  { name: 'AGENT.md', tool: 'Amp' },
  { name: 'GEMINI.md', tool: 'Gemini CLI' },
  { name: '.cursorrules', tool: 'Cursor' },
  { name: '.windsurfrules', tool: 'Windsurf' },
  { name: '.clinerules', tool: 'Cline' },
  { name: '.aiderules', tool: 'Aider' },
  { name: '.continuerules', tool: 'Continue' },
  { name: '.rules', tool: 'Zed' },
  { name: '.goosehints', tool: 'Goose' },
  { name: 'replit.md', tool: 'Replit' },
  { name: '.github/copilot-instructions.md', tool: 'GitHub Copilot' },
  { name: '.junie/guidelines.md', tool: 'Junie' },
  { name: '.junie/AGENTS.md', tool: 'Junie' },
  { name: '.goose/instructions.md', tool: 'Goose' },
];

// The agent rules directories whose unscoped files load every session. Only
// these: an arbitrary `docs/rules/` or `src/lint/rules/` is not an agent rules
// dir. Cursor's `.mdc` files live in `.cursor/rules/` and are handled by their
// `alwaysApply` flag.
const RULES_DIRS: ReadonlyArray<{ dir: string; tool: string }> = [
  { dir: '.claude/rules/', tool: 'Claude Code' },
  { dir: '.cursor/rules/', tool: 'Cursor' },
  { dir: '.windsurf/rules/', tool: 'Windsurf' },
  { dir: '.clinerules/', tool: 'Cline' },
  { dir: '.continue/rules/', tool: 'Continue' },
  { dir: '.aide/rules/', tool: 'Aide' },
  { dir: '.amazonq/rules/', tool: 'Amazon Q' },
  { dir: '.aiassistant/rules/', tool: 'JetBrains AI Assistant' },
];

const TOP_SECTIONS_TO_REPORT = 3;

/**
 * Quick frontmatter probe — returns true if the file has YAML frontmatter
 * containing a non-empty list-valued field. `paths:` is the .claude/rules
 * scoping convention; `globs:` is the Cursor/Windsurf one. Scoped rules
 * files are on-demand (loaded only when a path matches), so should be
 * excluded from always-loaded accounting.
 */
function hasFrontmatterList(content: string, field: string): boolean {
  // Split on CRLF too: `.` in the field pattern does not match a trailing
  // `\r`, so a CRLF `paths: "src/**"` line would never match.
  const lines = content.split(/\r?\n/);
  if (!isFrontmatterFence(lines[0] ?? '')) return false;
  const fieldPattern = new RegExp(`^${field}\\s*:\\s*(.*)$`);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (isFrontmatterFence(line)) return false;
    // The field can be inline ("paths: '**/*.ts'") or lead a YAML array.
    const match = line.match(fieldPattern);
    if (match) {
      const val = match[1].trim();
      if (val && val !== '[]') return true;
      // Empty inline — check the next non-blank line for a `- item` array entry.
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j];
        if (isFrontmatterFence(next)) return false;
        if (next.trim() === '') continue;
        if (next.trim().startsWith('- ')) return true;
        break;
      }
    }
  }
  return false;
}

/**
 * Inline scalar frontmatter field value (e.g. `trigger: glob` -> "glob"),
 * stripped of surrounding quotes. Null when the frontmatter or field is
 * absent or the value is empty.
 */
function frontmatterScalar(content: string, field: string): string | null {
  const lines = content.split(/\r?\n/);
  if (!isFrontmatterFence(lines[0] ?? '')) return null;
  const fieldPattern = new RegExp(`^${field}\\s*:\\s*(.*)$`);
  for (let i = 1; i < lines.length; i++) {
    if (isFrontmatterFence(lines[i])) return null;
    const match = lines[i].match(fieldPattern);
    if (match) return match[1].trim().replace(/^['"]|['"]$/g, '') || null;
  }
  return null;
}

/** Which tool loads `file` every session, and whether it is the project-root copy. */
interface AlwaysLoadedClass {
  tool: string;
  rootLevel: boolean;
}

function classifyAlwaysLoaded(file: ParsedContextFile): AlwaysLoadedClass | null {
  const rel = file.relativePath.replace(/\\/g, '/');

  // `.github/instructions/*` is always path-scoped per its client spec.
  if (rel.startsWith('.github/instructions/')) return null;

  // Cursor reads `alwaysApply` from the frontmatter of its rules (.mdc and
  // the folder-style RULE.md alike): true attaches the rule to every request
  // whatever its globs, false never does.
  const alwaysApply = frontmatterScalar(file.content, 'alwaysApply')?.toLowerCase();
  // `.mdc` rules are path-scoped (or manual) unless `alwaysApply: true`.
  if (rel.endsWith('.mdc')) {
    if (alwaysApply !== 'true') return null;
    return { tool: 'Cursor', rootLevel: rel.startsWith('.cursor/rules/') };
  }

  // Rules directories — check frontmatter. Rules *without* a scoping field
  // are always-loaded (per Anthropic docs). Path/glob-scoped rules load on
  // demand whatever the host: `paths:` is the .claude/rules convention,
  // `globs:` the Cursor/Windsurf one.
  for (const { dir, tool } of RULES_DIRS) {
    const rootLevel = rel.startsWith(dir);
    if (!rootLevel && !rel.includes('/' + dir)) continue;
    if (dir === '.cursor/rules/' && alwaysApply === 'true') return { tool, rootLevel };
    if (dir === '.cursor/rules/' && alwaysApply === 'false') return null;
    if (hasFrontmatterList(file.content, 'paths')) return null;
    if (hasFrontmatterList(file.content, 'globs')) return null;
    // Windsurf rules carry an explicit activation mode; only always_on loads
    // every session (glob / manual / model_decision are on-demand).
    if (dir === '.windsurf/rules/') {
      const trigger = frontmatterScalar(file.content, 'trigger');
      if (trigger && trigger.toLowerCase() !== 'always_on') return null;
    }
    return { tool, rootLevel };
  }

  const basename = rel.split('/').pop() ?? '';
  for (const { name, tool } of ALWAYS_LOADED_NAMES) {
    if (name.includes('/')) {
      // Suffix match -- the file's parent dir must match the required parent.
      if (rel === name || rel.endsWith('/' + name)) return { tool, rootLevel: rel === name };
    } else if (basename === name) {
      // Claude Code also reads the project memory from ./.claude/CLAUDE.md.
      const rootLevel = rel === name || (name === 'CLAUDE.md' && rel === '.claude/CLAUDE.md');
      return { tool, rootLevel };
    }
  }
  return null;
}

export function isAlwaysLoaded(file: ParsedContextFile): boolean {
  return classifyAlwaysLoaded(file) !== null;
}

interface SectionCost {
  title: string;
  line: number;
  tokens: number;
}

/**
 * The heading level the file is organised by: the shallowest level with at
 * least two sections (a lone H1 title over H2 chapters gives H2; H1 chapters
 * with one stray H2 stay H1), else the shallowest level present.
 */
function topSectionLevel(sections: Section[]): number {
  const counts = new Map<number, number>();
  for (const s of sections) counts.set(s.level, (counts.get(s.level) ?? 0) + 1);
  const levels = [...counts.keys()].sort((a, b) => a - b);
  return levels.find((l) => (counts.get(l) ?? 0) >= 2) ?? levels[0];
}

function computeSectionCosts(file: ParsedContextFile): SectionCost[] {
  if (file.sections.length === 0) return [];
  const topLevel = topSectionLevel(file.sections);
  const lines = file.content.split(/\r?\n/);
  return file.sections
    .filter((s) => s.level === topLevel)
    .map((s) => {
      const body = lines.slice(s.startLine - 1, s.endLine).join('\n');
      return { title: s.title, line: s.startLine, tokens: countTokens(body) };
    })
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Detect lines in always-loaded files that use inviolable framing
 * (NEVER / ALWAYS / DO NOT / MUST NOT) paired — in the same sentence — with
 * a backticked span. These are candidates for hook-based enforcement; without
 * a hook the agent may still do the thing anyway (rules are advisory — see
 * code.claude.com/docs/en/memory: "there's no guarantee of strict compliance,
 * especially for vague or conflicting instructions").
 *
 * The span is classified before it is reported (see classifySpan): a shell
 * command gets a deny / hook suggestion, a file a file-scoped deny, a Claude
 * Code tool name a tool deny, and anything else (an identifier, a code
 * pattern) an Edit|Write hook. Only the command case talks about blocking a
 * command.
 *
 * Same-sentence scoping is critical. An earlier version of this rule fired
 * on "Run `npm test`. Do not commit with failing tests" because both tokens
 * appeared on the same line — but `npm test` was not the object of `Do not`.
 * The sentence boundary (a period / exclamation / question mark followed by
 * whitespace, not counting abbreviations like "e.g.") eliminates that class
 * of false positive.
 *
 * Two further constraints, each grounded in a real misfire on factual prose:
 *
 *  1. The framing token must carry visible directive weight — at least one
 *     uppercase letter (NEVER, Never, do NOT, Must not). An all-lowercase
 *     "always" / "never" mid-sentence is almost always descriptive prose,
 *     not a rule: "the specs have always lived in `e2e/`" nominated a
 *     DIRECTORY for hook enforcement, and "this section is the always-on
 *     summary" nominated a filename. The lookarounds additionally reject
 *     compound words ("always-on", "always-loaded") and dotted identifiers
 *     ("applies-when.always"), which are never framing even when capitalized.
 *     Trade-off: a genuinely imperative all-lowercase "don't use `x`" is no
 *     longer nudged — an acceptable false negative for an info-severity rule
 *     whose documented posture is conservative.
 *
 *  2. The framing token must sit OUTSIDE inline code spans. A backticked
 *     `applies-when.always === true` contains the word "always", and the old
 *     single-regex scan matched it, then captured the PROSE between that code
 *     span and the next one as "the command". Code spans are masked before
 *     the framing search; only their contents remain candidates for the
 *     command capture.
 */
const FRAMING_TOKEN = /(?<![\w'’.-])(never|always|don['’]?t|do\s+not|must\s+not)(?![\w'’.-])/gi;

/** Max chars allowed between the framing token and the backticked command. */
const FRAMING_COMMAND_GAP = 80;

/** Abbreviations whose period does not end the sentence. */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf)\./gi;

/** A sentence end: terminator followed by whitespace or the end of the gap. */
const SENTENCE_END = /[.!?](?=\s|$)/;

interface InviolableMatch {
  framing: string;
  /** The backticked span's content. */
  command: string;
  /** Column of the framing token. */
  framingStart: number;
  /** Column of the span's opening backtick. */
  spanStart: number;
}

/**
 * Find the first (framing token, backticked span) pair on a line under the
 * constraints documented above, or null. Mirrors the old regex's "first match
 * on the line" behavior.
 */
function findInviolableCommand(line: string): InviolableMatch | null {
  const spans = inlineCodeSpans(line);
  if (spans.length === 0) return null;
  const masked = maskCodeSpans(line, spans);

  FRAMING_TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FRAMING_TOKEN.exec(masked)) !== null) {
    const token = m[1];
    // All-lowercase = prose ("have always lived in"), not directive framing.
    if (token === token.toLowerCase()) continue;
    const afterIdx = m.index + m[0].length;
    // The command is the FIRST code span after the token, in the same
    // sentence and within the gap budget.
    const span = spans.find((s) => s.start >= afterIdx);
    if (!span) continue;
    const gap = masked.slice(afterIdx, span.start);
    if (gap.length > FRAMING_COMMAND_GAP) continue;
    if (SENTENCE_END.test(gap.replace(ABBREVIATIONS, ''))) continue;
    return { framing: token, command: span.content, framingStart: m.index, spanStart: span.start };
  }
  return null;
}

// --- What the backticked span is -------------------------------------------

/** Single-token spans that are commands on their own (`rm`, `terraform`). */
const COMMAND_HEADS = new Set([
  'apt',
  'apt-get',
  'aws',
  'az',
  'bash',
  'brew',
  'bun',
  'bunx',
  'cargo',
  'chmod',
  'chown',
  'cp',
  'curl',
  'dd',
  'deno',
  'docker',
  'dotnet',
  'eval',
  'exec',
  'firebase',
  'gcloud',
  'gh',
  'git',
  'go',
  'gradle',
  'helm',
  'kill',
  'killall',
  'kubectl',
  'make',
  'mkfs',
  'mv',
  'mvn',
  'mysql',
  'netlify',
  'node',
  'npm',
  'npx',
  'pip',
  'pip3',
  'pkill',
  'pnpm',
  'psql',
  'pwsh',
  'python',
  'python3',
  'reboot',
  'rm',
  'rmdir',
  'rsync',
  'scp',
  'sh',
  'shutdown',
  'ssh',
  'sudo',
  'su',
  'systemctl',
  'terraform',
  'vercel',
  'wget',
  'wrangler',
  'yarn',
  'zsh',
]);

/**
 * Claude Code tool names (case-sensitive, as permission rules and hook
 * matchers spell them). Other agents' tools are not enforceable through
 * .claude/settings.json anyway.
 */
const CLAUDE_TOOLS = new Set([
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'LS',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'Skill',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]);

type SpanKind = 'command' | 'file' | 'tool' | 'code';

/**
 * A verb in the framing gap that says the span is executed ("NEVER run
 * `pytest`"). `use` is deliberately absent: "Never use `any`" names an
 * identifier, not a program.
 */
const RUN_VERB =
  /(?<![A-Za-z])(?:run|runs|running|execute|executes|executing|invoke|invokes|invoking)(?![A-Za-z])/i;

/**
 * Shell command: two or more words (`git push --force`, `npm login`), a known
 * command head on its own (`rm`), a script (`release.sh`), a ./ path to an
 * executable, or any single word the framing says to run (`run \`pytest\``).
 * File: one token that is a path or a file name. Tool: a Claude Code tool
 * name. Anything else (an identifier like `any`, a call like
 * `process.kill()`) is code.
 */
function classifySpan(span: string, framingGap: string): SpanKind {
  const tokens = span.trim().split(/\s+/);
  const head = tokens[0];
  if (tokens.length === 1 && (CLAUDE_TOOLS.has(head) || /^mcp__\w+$/.test(head))) return 'tool';
  if (/^\.{1,2}\//.test(head)) return 'command';
  if (tokens.length >= 2) return 'command';
  if (COMMAND_HEADS.has(head)) return 'command';
  if (/\.(?:sh|bash|ps1|bat|cmd)$/i.test(head)) return 'command';
  if (!/[()]/.test(head) && RUN_VERB.test(framingGap)) return 'command';
  if (!/[()]/.test(head) && looksLikeFile(head)) return 'file';
  return 'code';
}

/**
 * Extensions that make a dotted token a file name. Anything else after the
 * last dot (`JSON.parse`, `fs.readFile`) is a member access, i.e. code;
 * CODE_OBJECT_STEMS covers members that collide with an extension
 * (`console.log`, `process.env`).
 */
const FILE_EXTENSIONS = new Set(
  (
    'md mdc mdx txt rst adoc json jsonc json5 yaml yml toml ini cfg conf env lock log csv tsv ' +
    'xml html htm css scss sass less js mjs cjs jsx ts mts cts tsx py pyi rb go rs java kt kts ' +
    'swift c h cc cpp hpp cs php sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto vue ' +
    'svelte astro lua pl dart scala ex exs erl hs clj gradle properties tf tfvars hcl ' +
    'dockerfile png jpg jpeg gif svg ico pdf zip gz tgz tar wasm pem crt db sqlite sqlite3 bak ' +
    'ipynb gitignore gitattributes editorconfig npmrc nvmrc prettierrc eslintrc babelrc ' +
    'mod sum lockb snap csproj fsproj vbproj sln plist nix xcodeproj pbxproj gemspec ' +
    'podspec cabal mk cmake bazel bzl sbt whl jar war exe dll dylib p12 pfx cer'
  ).split(' '),
);

/** Stems that make `<stem>.<member>` a member access even when the member is an extension. */
const CODE_OBJECT_STEMS = new Set([
  'console',
  'process',
  'window',
  'document',
  'globalThis',
  'self',
  'this',
  'logger',
  'logging',
  'log',
  'Math',
  'JSON',
  'Object',
  'Array',
  'Promise',
  // `np.sum`, `_.sum`: library namespaces whose members collide with `sum`/`mod`.
  '_',
  'lodash',
  'np',
  'numpy',
  'pd',
  'torch',
  'math',
]);

/**
 * A path (contains `/`), a dotfile (`.env`, `.env.local`), or a name whose
 * last extension is a known file extension (`package-lock.json`, `app.log`).
 */
function looksLikeFile(token: string): boolean {
  if (token.includes('/')) return true;
  if (/^\.[A-Za-z0-9]/.test(token)) return true;
  const m = /^([^.]+)(?:\.[^.]+)*\.([A-Za-z0-9]{1,12})$/.exec(token);
  if (!m) return false;
  if (CODE_OBJECT_STEMS.has(m[1])) return false;
  return FILE_EXTENSIONS.has(m[2].toLowerCase());
}

/**
 * The span as a whole word: letters, digits and `_` flanking it kill the
 * match, so `any` is not found inside "company".
 */
function spanPattern(span: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(span)}(?![A-Za-z0-9_])`);
}

/**
 * Does a hook with this matcher see file edits? Empty or `*` selects every
 * tool (and Stop hooks have no matcher); otherwise it must select Edit, Write
 * or MultiEdit -- the hook shape the code/file suggestion asks for.
 */
function hookSeesEdits(matcher: string): boolean {
  const m = matcher.trim();
  return m === '' || m === '*' || ['Edit', 'Write', 'MultiEdit'].some((t) => matcherSelects(m, t));
}

interface ParsedCommand {
  /** Positional words, in order (`git`, `push`, `origin`). */
  words: string[];
  /** Option tokens (`--force`, `-rf`). */
  flags: string[];
}

function parseCommand(text: string): ParsedCommand {
  const words: string[] = [];
  const flags: string[] = [];
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    if (tok === '-' || tok === '--') continue;
    (tok.startsWith('-') ? flags : words).push(tok);
  }
  return { words, flags };
}

/**
 * The command name used for fuzzy matching against hook names and script
 * contents: everything before the first option, e.g. `npm publish --access
 * public` reduces to `npm publish`. Flags are matched separately (see
 * denyEnforces) and stay in the displayed suggestion.
 */
function commandBase(backticked: string): string {
  const beforeFlags = backticked.trim().split(/\s+--?/, 1)[0];
  return beforeFlags.replace(/\s+/g, ' ');
}

/**
 * Build a regex that matches a command against settings entries tolerantly.
 *
 * The trick is that `\b` treats `_` and digits as word chars but `-` as a
 * non-word char. That asymmetry means naive `\b`-anchored matching is
 * wrong in both directions:
 *
 *  - For multi-token commands: `\bnpm login\b` does not match
 *    `block_npm_login.py` (no boundary between `_` and `n`) AND does not
 *    match `block-npm-login.sh` (the literal space between tokens is
 *    missing). Both are real hook script naming styles we want to credit.
 *  - For single-token commands: `\brm\b` falsely matches
 *    `npm run rm-old-logs` (boundary on each side of `rm`, since `-` is
 *    non-word), silently suppressing a real enforcement-missing warning.
 *
 * Strategy:
 *
 *  - Tokens of multi-token commands are joined with `[\s\-_]+` so the
 *    body matches all three forms (`npm login`, `npm-login`, `npm_login`).
 *  - Boundary on each end is a manual lookaround `(?<![A-Za-z0-9])` /
 *    `(?![A-Za-z0-9])`. Letters and digits flanking the match still kill
 *    it (so `pnpm` still doesn't match `npm`, `loginx` doesn't match
 *    `login`), but `_` and `-` are *allowed* on the boundary, which lets
 *    `block_npm_login.py` and `block-npm-login.sh` match.
 *  - For single-token commands, we additionally exclude `_` and `-` from
 *    the boundary class so `rm` stays out of `rm-old-logs` / `block_rm`.
 *    We give up on matching `block-rm.sh` (a hook script for `rm`) — those
 *    are rare in practice (deny-list entries are the common form) and the
 *    `rm-old-logs` false negative is the higher-cost bug.
 */
function buildCommandPattern(cmd: string): RegExp {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const escaped = tokens.map(escapeRegex);
  if (tokens.length === 1) {
    return new RegExp(`(?<![A-Za-z0-9_\\-])${escaped[0]}(?![A-Za-z0-9_\\-])`, 'i');
  }
  const body = escaped.join('[\\s\\-_]+');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Permission-rule token match: `*` is a wildcard, otherwise case-insensitive equality. */
function tokenMatches(pattern: string, token: string): boolean {
  const re = pattern.split('*').map(escapeRegex).join('.*');
  return new RegExp(`^${re}$`, 'i').test(token);
}

/**
 * Does a permissions entry block (or gate) the rule's command? Only Bash
 * rules can. A prefix entry (trailing `:*`, ` *` or `*`) enforces when it is
 * at least as broad as the command: its positional words are a prefix of the
 * command's and every flag it names appears in the command. So
 * `Bash(git push:*)` enforces "NEVER `git push --force`", while
 * `Bash(git push --force:*)` does not enforce "NEVER `git push`" (plain
 * `git push` still runs). An exact entry (`Bash(git push)`) applies to that
 * exact command only, so it enforces only a rule naming the same words and
 * flags.
 */
function denyEnforces(entry: string, cmd: ParsedCommand): boolean {
  const trimmed = entry.trim();
  if (trimmed === 'Bash' || trimmed === 'Bash(*)') return true;
  const m = /^Bash\((.*)\)$/s.exec(trimmed);
  if (!m) return false;
  const body = m[1].trim();
  const prefix = body.endsWith('*');
  const rule = parseCommand(body.replace(/:\*$/, '').replace(/\s+\*$/, ''));
  if (rule.words.length === 0 || rule.words.length > cmd.words.length) return false;
  if (!prefix && rule.words.length !== cmd.words.length) return false;
  if (!rule.words.every((w, i) => tokenMatches(w, cmd.words[i]))) return false;
  if (!rule.flags.every((f) => cmd.flags.some((cf) => tokenMatches(f, cf)))) return false;
  return prefix || cmd.flags.every((cf) => rule.flags.some((f) => tokenMatches(f, cf)));
}

/** Does an Edit/Write permissions entry cover the file? */
function fileDenyEnforces(entry: string, file: string): boolean {
  const m = /^(?:Edit|Write|MultiEdit|NotebookEdit)\((.*)\)$/s.exec(entry.trim());
  if (!m) return false;
  const glob = m[1].trim().replace(/^\.\//, '').replace(/^\/+/, '');
  const target = file.replace(/^\.\//, '');
  const re = glob
    .split(/(\*\*\/?|\*)/)
    .map((part) => (part.startsWith('**') ? '.*' : part === '*' ? '[^/]*' : escapeRegex(part)))
    .join('');
  return new RegExp(`^(?:.*/)?${re}$`).test(target);
}

/**
 * Does a hook matcher select the tool? Matchers are case-sensitive regexes
 * over tool names (`Edit|Write`), so `webfetch` does not select WebFetch.
 */
function matcherSelects(matcher: string, tool: string): boolean {
  if (!matcher) return false;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return matcher.split('|').some((alt) => alt.trim() === tool);
  }
}

// --- Settings -----------------------------------------------------------------

interface HookEntry {
  matcher?: string;
  hooks?: Array<{ command?: string }>;
}

interface Settings {
  permissions?: { deny?: string[]; ask?: string[] };
  hooks?: {
    PreToolUse?: HookEntry[];
    Stop?: HookEntry[];
  };
}

// Cache parsed settings per projectRoot. checkTierTokens runs once PER
// always-loaded file, so without this the read+parse (and, crucially, the
// malformed-settings console.warn) would fire N times for one settings.json.
// Caching collapses that to one parse + at most one warn per (root, audit
// run). The cache key includes a stat fingerprint of the candidate files so
// a long-running process (MCP server, --watch) that edits settings.json
// between audits is never served pre-edit results — without it, adding the
// suggested deny entry and re-auditing in the same session would still
// report hard-enforcement-missing. Resettable for tests.
let settingsCache: {
  root: string;
  includeGlobal: boolean;
  fingerprint: string;
  data: Settings[];
} | null = null;

function fingerprintFiles(paths: string[]): string {
  return paths
    .map((p) => {
      try {
        const st = fs.statSync(p);
        return `${st.mtimeMs}:${st.size}`;
      } catch {
        return 'absent';
      }
    })
    .join('|');
}

function loadSettingsSources(projectRoot: string, includeGlobal: boolean): Settings[] {
  const candidates = [
    path.join(projectRoot, '.claude', 'settings.json'),
    path.join(projectRoot, '.claude', 'settings.local.json'),
  ];
  // The user-global settings.json is opt-in (includeGlobal), mirroring
  // hook-coverage's --hooks-global gate. It is resolved with claudeConfigDir()
  // (CLAUDE_CONFIG_DIR, else <home>/.claude), the helper every home-scoped
  // pillar uses, so the checks agree on which file "the user-global settings"
  // means. On a default project-scoped run we do NOT consult personal global
  // settings, so a teammate's private deny/hook can't silently suppress a
  // hard-enforcement-missing finding that wouldn't reproduce for anyone else.
  const configDir = includeGlobal ? claudeConfigDir() : '';
  if (configDir) {
    candidates.push(path.join(configDir, 'settings.json'));
  }

  const fingerprint = fingerprintFiles(candidates);
  if (
    settingsCache?.root === projectRoot &&
    settingsCache.includeGlobal === includeGlobal &&
    settingsCache.fingerprint === fingerprint
  ) {
    return settingsCache.data;
  }

  const sources: Settings[] = [];
  for (const p of candidates) {
    let content: string;
    try {
      content = stripBom(fs.readFileSync(p, 'utf-8'));
    } catch {
      // Missing file is expected — not every repo has .claude/settings.json.
      continue;
    }
    // Parse with the same leniency hook-coverage uses (jsonc, trailing commas
    // allowed) so the two settings consumers never disagree about whether the
    // same file is readable. Genuinely malformed settings silently skipped
    // would mean tier-tokens reports "no hook enforcement" even when there is
    // one — surface the parse failure on stderr so it's fixable.
    const errors: ParseError[] = [];
    const data = parseJsonc(content, errors, { allowTrailingComma: true }) as Settings | undefined;
    if (errors.length > 0) {
      console.warn(
        `ctxlint: could not parse ${p}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`,
      );
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    sources.push(data);
  }
  settingsCache = { root: projectRoot, includeGlobal, fingerprint, data: sources };
  return sources;
}

/** Clear the per-root settings cache. Call between audit runs / in tests. */
export function resetSettingsCache(): void {
  settingsCache = null;
}

// --- Hook commands and scripts --------------------------------------------------

/**
 * The interpreter (and its options) that launches a hook script: in
 * `bash .claude/hooks/guard.sh` the `bash` runs the hook, it is not a command
 * the hook blocks.
 */
const INTERPRETER_PREFIX =
  /^\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:\S*\/)?(?:bash|sh|zsh|dash|node|python3?|pwsh|powershell(?:\.exe)?|deno\s+run|bun|tsx|ruby|perl)(?:\s+-{1,2}[A-Za-z][\w-]*)*\s+/;

const SCRIPT_EXTENSION = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|ps1|rb|pl)$/i;

/** Largest hook script read for its contents. */
const MAX_SCRIPT_BYTES = 256 * 1024;

function isWithin(child: string, parent: string): boolean {
  if (!parent) return false;
  const rel = path.relative(parent, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Script files a hook command runs, resolved to absolute paths. Only scripts
 * inside the project or the Claude config dir are returned: the check reads
 * them, and has no business reading arbitrary files a settings file names.
 */
function hookScriptPaths(command: string, projectRoot: string): string[] {
  const out: string[] = [];
  const configDir = claudeConfigDir();
  for (const raw of command.split(/\s+/)) {
    let tok = raw.replace(/["']/g, '');
    if (!SCRIPT_EXTENSION.test(tok)) continue;
    tok = tok.replace(/^\$\{?CLAUDE_PROJECT_DIR\}?/, projectRoot);
    const home = /^(?:~|\$\{?HOME\}?)\//.exec(tok);
    if (home) {
      const h = homeDir();
      if (!h) continue;
      tok = path.join(h, tok.slice(home[0].length));
    }
    const abs = path.isAbsolute(tok) ? tok : path.resolve(projectRoot, tok);
    if (isWithin(abs, projectRoot) || isWithin(abs, configDir)) out.push(abs);
  }
  return out;
}

/** Hook command text plus the contents of the scripts it runs, per hook. */
type HookTexts = Array<{ matcher: string; command: string; scripts: string[] }>;

function collectHookTexts(settings: Settings[], projectRoot: string): HookTexts {
  const out: HookTexts = [];
  const scriptCache = new Map<string, string | null>();
  const readScript = (p: string): string | null => {
    if (!scriptCache.has(p)) {
      let text: string | null = null;
      try {
        if (fs.statSync(p).size <= MAX_SCRIPT_BYTES) text = fs.readFileSync(p, 'utf-8');
      } catch {
        // Missing script: hook-coverage/dead-hook reports it.
      }
      scriptCache.set(p, text);
    }
    return scriptCache.get(p) ?? null;
  };
  for (const s of settings) {
    // PreToolUse gates the action before it runs; Stop verifies it after the
    // turn. Both are shapes the ALWAYS-branch suggestion explicitly offers
    // ("a PreToolUse or Stop hook"), so both must be credited — otherwise
    // following the suggestion leaves the finding firing forever.
    for (const h of [...(s.hooks?.PreToolUse ?? []), ...(s.hooks?.Stop ?? [])]) {
      for (const sub of h.hooks ?? []) {
        const command = sub.command ?? '';
        const scripts = hookScriptPaths(command, projectRoot)
          .map(readScript)
          .filter((t): t is string => t !== null);
        out.push({ matcher: h.matcher ?? '', command, scripts });
      }
    }
  }
  return out;
}

interface EnforcementTarget {
  kind: SpanKind;
  /** The span as written (whitespace-normalized). */
  span: string;
  prohibitive: boolean;
}

/**
 * Is the rule's target backed by settings? deny physically blocks; ask gates
 * behind a human prompt. Both are non-advisory (the agent can't just
 * proceed), so both count — ask is the weaker form but still a hard gate.
 * Hooks are credited when their command, or the contents of the script they
 * run, name the target; for a NEVER command rule the hook must also see Bash
 * calls (see the command case). A tool-name matcher only credits a tool rule:
 * the `Bash` matcher says which tool a hook sees, not which command it blocks.
 */
function isEnforced(target: EnforcementTarget, settings: Settings[], hooks: HookTexts): boolean {
  const entries = settings.flatMap((s) => [
    ...(s.permissions?.deny ?? []),
    ...(s.permissions?.ask ?? []),
  ]);
  switch (target.kind) {
    case 'command': {
      const cmd = parseCommand(target.span);
      if (entries.some((e) => denyEnforces(e, cmd))) return true;
      const base = commandBase(target.span);
      const pattern = buildCommandPattern(base);
      if (!target.prohibitive) {
        // ALWAYS: a hook that runs the command enforces it, whatever it sees.
        return hooks.some(
          (h) =>
            pattern.test(h.command.replace(INTERPRETER_PREFIX, '')) ||
            h.scripts.some((t) => pattern.test(t)),
        );
      }
      // NEVER: only a hook that sees Bash calls can block the command, and a
      // script merely USING it (a formatter's cleanup `rm -f`) blocks nothing.
      // So script contents count only for a multi-word base (`npm login`), or
      // a single head on the same line as every banned flag (`rm -rf`); a bare
      // single head (`rm`) is too common in scripts to credit.
      const multiWord = base.includes(' ');
      return hooks.some(
        (h) =>
          hookSeesBash(h.matcher) &&
          (pattern.test(h.command.replace(INTERPRETER_PREFIX, '')) ||
            ((multiWord || cmd.flags.length > 0) &&
              h.scripts.some((t) => scriptNamesCommand(t, pattern, multiWord, cmd.flags)))),
      );
    }
    case 'code':
      // Defensive: a deny entry naming the span (`Bash(foo:*)`) says the user
      // treats it as a command, whatever classifySpan decided.
      if (entries.some((e) => denyEnforces(e, parseCommand(target.span)))) return true;
      // Likewise an Edit(...) deny on a dotted span (`schema.prisma2`) says
      // the user treats it as a file the extension list does not know.
      if (
        target.prohibitive &&
        target.span.includes('.') &&
        entries.some((e) => fileDenyEnforces(e, target.span))
      ) {
        return true;
      }
      return hookNamesSpan(hooks, target.span);
    case 'file':
      if (target.prohibitive && entries.some((e) => fileDenyEnforces(e, target.span))) {
        return true;
      }
      return hookNamesSpan(hooks, target.span);
    case 'tool':
      if (entries.some((e) => e.trim() === target.span || e.trim() === `${target.span}(*)`)) {
        return true;
      }
      return hooks.some((h) => matcherSelects(h.matcher, target.span));
  }
}

/**
 * A code or file span is credited only by a hook that sees edits and names
 * the span as a whole word in its command or script text.
 */
function hookNamesSpan(hooks: HookTexts, span: string): boolean {
  const pattern = spanPattern(span);
  return hooks.some(
    (h) =>
      hookSeesEdits(h.matcher) &&
      (pattern.test(h.command) || h.scripts.some((t) => pattern.test(t))),
  );
}

/** Does a hook with this matcher see Bash calls? Empty or `*` selects every tool. */
function hookSeesBash(matcher: string): boolean {
  const m = matcher.trim();
  return m === '' || m === '*' || matcherSelects(m, 'Bash');
}

/**
 * Does a hook script name the command? A multi-word base anywhere counts (a
 * guard on `git push` blocks `git push --force` too). A single head counts
 * only on a line that also carries every banned flag as its own token.
 */
function scriptNamesCommand(
  script: string,
  pattern: RegExp,
  multiWord: boolean,
  flags: string[],
): boolean {
  if (multiWord) return pattern.test(script);
  const flagPatterns = flags.map(
    (f) => new RegExp(`(?<![A-Za-z0-9_-])${escapeRegex(f)}(?![A-Za-z0-9_-])`),
  );
  return script
    .split(/\r?\n/)
    .some((l) => pattern.test(l) && flagPatterns.every((fp) => fp.test(l)));
}

// --- The finding -----------------------------------------------------------------

/** Longest span text quoted in a message or suggestion. */
const MAX_QUOTED_SPAN = 60;

function capSpan(text: string): string {
  return text.length > MAX_QUOTED_SPAN ? `${text.slice(0, MAX_QUOTED_SPAN)}...` : text;
}

function buildSuggestion(target: EnforcementTarget, quoted: string): string {
  const advisory = 'Rules in always-loaded files are advisory.';
  switch (target.kind) {
    case 'command':
      return target.prohibitive
        ? `${advisory} For \`${quoted}\`, add a PreToolUse hook (or permissions.deny entry) in .claude/settings.json so the command is physically blocked.`
        : `${advisory} For \`${quoted}\`, add a hook in .claude/settings.json (e.g. a PreToolUse or Stop hook that runs or verifies \`${quoted}\`) so the requirement doesn't depend on the agent remembering.`;
    case 'file':
      return target.prohibitive
        ? `${advisory} For \`${quoted}\`, add a permissions.deny entry such as \`Edit(${quoted})\` (or a PreToolUse hook on Edit|Write) in .claude/settings.json so the file cannot be changed.`
        : `${advisory} For \`${quoted}\`, add a Stop hook in .claude/settings.json that verifies \`${quoted}\` so the requirement doesn't depend on the agent remembering.`;
    case 'tool':
      return `${advisory} For the \`${quoted}\` tool, add a permissions.deny entry \`${quoted}\` (or a PreToolUse hook with matcher "${quoted}") in .claude/settings.json so the tool is blocked.`;
    case 'code':
      return target.prohibitive
        ? `${advisory} To enforce the rule on \`${quoted}\`, add a PreToolUse hook on Edit|Write in .claude/settings.json that rejects edits introducing it.`
        : `${advisory} To enforce the rule on \`${quoted}\`, add a Stop hook (or a PostToolUse hook on Edit|Write) in .claude/settings.json that checks for it.`;
  }
}

function checkHardEnforcement(
  file: ParsedContextFile,
  settings: Settings[],
  projectRoot: string,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const lines = file.content.split(/\r?\n/);
  // A directive can only be written in PROSE. Fenced blocks and HTML comments
  // are illustration and commentary, so scanning them produced findings about
  // sample text -- a ```markdown fence demonstrating "NEVER run `terraform
  // apply`" was reported as if it were this repo's own unenforced rule. This
  // check scans raw content, so it applies the shared markdown.ts mask that
  // the other prose scanners use.
  const nonProse = nonProseLineMask(lines);
  let hooks: HookTexts | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (nonProse[i]) continue;
    // The mask is line-granular, so a prose line carrying a trailing
    // `<!-- ... -->` annotation stays in scope; blank the annotation's own text
    // so it cannot be read as an instruction.
    const line = stripInlineHtmlComments(lines[i]);
    // Match inviolable framing + backticked span within the same sentence.
    // Scans the full span content — no `/`-exclusion that previously dropped
    // `./release.sh`.
    const match = findInviolableCommand(line);
    if (!match) continue;
    const span = match.command.trim().replace(/\s+/g, ' ');
    if (!span) continue;
    const prohibitive = match.framing.toUpperCase() !== 'ALWAYS';
    const kind = classifySpan(span, line.slice(match.framingStart, match.spanStart));
    // A hook cannot make the agent reach for a tool, only stop it using one.
    if (kind === 'tool' && !prohibitive) continue;
    const target: EnforcementTarget = { kind, span, prohibitive };
    hooks ??= collectHookTexts(settings, projectRoot);
    if (isEnforced(target, settings, hooks)) continue;
    // Quote only the directive -- framing word through the span -- not the
    // whole line, and redact before capping so a token cut by the cap cannot
    // slip past the audit's redaction.
    const quoted = capSpan(redactSecrets(span));
    const directive = `${redactSecrets(line.slice(match.framingStart, match.spanStart))}\`${quoted}\``;
    issues.push({
      severity: 'info',
      check: 'tier-tokens',
      ruleId: 'tier-tokens/hard-enforcement-missing',
      line: i + 1,
      message: `Inviolable framing ("${directive}") without a hook to back it up`,
      suggestion: buildSuggestion(target, quoted),
    });
  }
  return issues;
}

export async function checkTierTokens(
  file: ParsedContextFile,
  projectRoot: string,
  thresholds: TokenThresholds = DEFAULT_TOKEN_THRESHOLDS,
  includeGlobal = false,
): Promise<LintIssue[]> {
  if (!isAlwaysLoaded(file)) return [];

  const issues: LintIssue[] = [];
  const threshold = thresholds.tierBreakdown;

  // Rule 1: section-breakdown — heaviest top-level sections for large files.
  if (file.totalTokens >= threshold) {
    const sectionCosts = computeSectionCosts(file);
    if (sectionCosts.length > 0) {
      const top = sectionCosts.slice(0, TOP_SECTIONS_TO_REPORT);
      const heaviest = top[0];
      const pct = Math.round((heaviest.tokens / file.totalTokens) * 100);
      const detail = top
        .map((s) => `  - "${s.title}" (L${s.line}): ~${s.tokens.toLocaleString()} tokens`)
        .join('\n');
      issues.push({
        severity: 'info',
        check: 'tier-tokens',
        ruleId: 'tier-tokens/section-breakdown',
        line: heaviest.line,
        message: `${file.totalTokens.toLocaleString()} tokens loaded every session — heaviest top-level section${top.length === 1 ? '' : 's'}:`,
        detail,
        suggestion: `"${heaviest.title}" is ~${heaviest.tokens.toLocaleString()} tokens (${pct}% of file). Consider demoting to an on-demand tier (skill, subagent, or memory) so it loads only when relevant.`,
      });
    }
  }

  // Rule 2: hard-enforcement-missing — inviolable framing without a hook.
  const settings = loadSettingsSources(projectRoot, includeGlobal);
  issues.push(...checkHardEnforcement(file, settings, projectRoot));

  return issues;
}

/**
 * Project-relative, forward-slash path a symlink points at, or null when the
 * target is absolute (it cannot be related to the relative paths in the set).
 */
function linkTarget(file: ParsedContextFile): string | null {
  if (!file.isSymlink || !file.symlinkTarget) return null;
  const target = file.symlinkTarget.replace(/\\/g, '/');
  if (path.posix.isAbsolute(target) || /^[A-Za-z]:/.test(target)) return null;
  const rel = file.relativePath.replace(/\\/g, '/');
  return path.posix.normalize(path.posix.join(path.posix.dirname(rel), target));
}

/**
 * Cross-file: sum tokens across the files ONE tool loads into every session.
 *
 * Only project-root always-loaded files count (a nested CLAUDE.md loads when
 * the agent works in that subtree, not every session), totals are per tool
 * (no session loads CLAUDE.md and GEMINI.md together), and a symlink to
 * another counted file of the same tool is the same content counted once.
 * Emits a single warning, for the heaviest tool, when its total reaches the
 * tierAggregate threshold.
 */
export function checkAggregateTierTokens(
  files: ParsedContextFile[],
  thresholds: TokenThresholds = DEFAULT_TOKEN_THRESHOLDS,
): LintIssue | null {
  const byTool = new Map<string, ParsedContextFile[]>();
  for (const f of files) {
    const c = classifyAlwaysLoaded(f);
    if (!c?.rootLevel) continue;
    const group = byTool.get(c.tool) ?? [];
    group.push(f);
    byTool.set(c.tool, group);
  }

  // Case-insensitive default filesystems (win32, darwin) fold like scanner globs.
  const nocase = process.platform === 'win32' || process.platform === 'darwin';
  const fold = (p: string) => (nocase ? p.toLowerCase() : p);

  let worst: { tool: string; files: ParsedContextFile[]; total: number } | null = null;
  for (const [tool, group] of byTool) {
    const paths = new Set(group.map((f) => fold(f.relativePath.replace(/\\/g, '/'))));
    let counted = group.filter((f) => {
      const target = linkTarget(f);
      return !(target !== null && paths.has(fold(target)));
    });
    // Codex reads AGENTS.override.md INSTEAD of AGENTS.md in the same directory.
    if (counted.some((f) => f.relativePath === 'AGENTS.override.md')) {
      counted = counted.filter((f) => f.relativePath !== 'AGENTS.md');
    }
    if (counted.length < 2) continue;
    const total = counted.reduce((sum, f) => sum + f.totalTokens, 0);
    if (total < thresholds.tierAggregate) continue;
    if (!worst || total > worst.total) worst = { tool, files: counted, total };
  }
  if (!worst) return null;

  const breakdown = worst.files
    .slice()
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, 5)
    .map((f) => `  - ${f.relativePath}: ~${f.totalTokens.toLocaleString()} tokens`)
    .join('\n');

  return {
    severity: 'warning',
    check: 'tier-tokens',
    ruleId: 'tier-tokens/aggregate',
    line: 0,
    message: `${worst.files.length} always-loaded ${worst.tool} files total ${worst.total.toLocaleString()} tokens — loaded every session`,
    detail: breakdown,
    suggestion:
      'Consider moving the largest files or their heaviest sections to on-demand tiers (skills, subagents, memory).',
  };
}
