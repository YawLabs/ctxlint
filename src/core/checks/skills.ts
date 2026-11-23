import * as path from 'node:path';
import { fileExists, isDirectory } from '../../utils/fs.js';
import { classifyLines, inlineCodeSpans, maskCodeSpans } from '../../utils/markdown.js';
import type { LintIssue, SkillContext, SkillFile } from '../types.js';

/**
 * Agent-skill linting (fourth pillar, v1). Lints Claude Code skill + agent
 * definition files under ~/.claude (see AGENT_SKILL_LINT_SPEC.md). Rules:
 *
 *  - skill/missing-frontmatter   — required (agent) or recommended (skill)
 *                                  frontmatter absent
 *  - skill/broken-ref            — a ./ or ../ path reference in the body that
 *                                  doesn't resolve against the file's directory
 *  - skill/trigger-collision     — two skills declare the same trigger phrase
 *  - skill/orphaned              — a skills/<name>/ dir with no SKILL.md
 *  - skill/dead-tool-restriction — a tool restriction (an agent's tools /
 *                                  disallowedTools, a skill's allowed-tools /
 *                                  disallowed-tools) names a tool that isn't a
 *                                  known Claude Code tool
 *
 * v1 is intentionally tight: Claude-Code-only, conservative heuristics.
 */

// Frontmatter per kind, per the Claude Code docs (checked 2026-11-22):
//  - Skills (code.claude.com/docs/en/skills): "All fields are optional. Only
//    `description` is recommended". `name` defaults to the directory name and
//    a missing `description` falls back to the first non-empty line of the
//    body, so nothing is required; a missing description is reported as info.
//  - Agents (code.claude.com/docs/en/sub-agents): "Only `name` and
//    `description` are required."
const REQUIRED_FIELDS: Record<SkillFile['kind'], string[]> = {
  skill: [],
  agent: ['name', 'description'],
};
const RECOMMENDED_FIELDS: Record<SkillFile['kind'], string[]> = {
  skill: ['description'],
  agent: [],
};

interface Frontmatter {
  found: boolean;
  unclosed: boolean;
  /**
   * Top-level fields (key -> value). Scalars are unquoted/unescaped, block
   * scalars and multi-line plain scalars are folded into one string, and list
   * values (`- item` lines or inline `[a, b]`) are joined with ", ".
   */
  fields: Record<string, string>;
  /** 1-indexed line the closing `---` sits on (or content length if unclosed). */
  endLine: number;
}

/**
 * Minimal YAML-frontmatter reader for skill/agent files. Kept local to this
 * module (the context pillar's frontmatter check has its own reader with a
 * different contract). Handles top-level `key: value` pairs whose value is a
 * plain, single-quoted or double-quoted scalar (possibly continued on indented
 * lines), a `|` / `>` block scalar, an inline `[a, b]` array, or a `- item`
 * list. Nested mappings are not interpreted -- no rule here reads one.
 */
function parseFrontmatter(content: string): Frontmatter {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { found: false, unclosed: false, fields: {}, endLine: 0 };
  }
  let endLine = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      endLine = i + 1;
      break;
    }
  }
  const body = lines.slice(1, endLine === 0 ? lines.length : endLine - 1);
  const fields = parseFields(body);
  if (endLine === 0) return { found: true, unclosed: true, fields, endLine: lines.length };
  return { found: true, unclosed: false, fields, endLine };
}

const TOP_LEVEL_KEY = /^([\w-]+)\s*:(?:\s+(.*))?$/;

function parseFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    const m = TOP_LEVEL_KEY.exec(lines[i]);
    if (!m) {
      i++;
      continue;
    }
    // Everything up to the next column-0 line belongs to this key: indented
    // continuation/block lines, blank lines, and `- item` entries (YAML lets a
    // list under a key start at the key's own column).
    const cont: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || /^(?:\s|- |-$)/.test(lines[j]))) {
      cont.push(lines[j]);
      j++;
    }
    fields[m[1]] = scalarValue((m[2] ?? '').trim(), cont);
    i = j;
  }
  return fields;
}

function stripComment(plain: string): string {
  return plain.replace(/(?:^|\s+)#.*$/, '').trim();
}

/** Value of a key given the text after `key:` and its continuation lines. */
function scalarValue(rest: string, cont: string[]): string {
  const contText = cont.map((l) => l.trim()).filter(Boolean);

  if (rest === '' || rest.startsWith('#')) {
    if (contText.length > 0 && contText.every((l) => l.startsWith('-'))) {
      return contText
        .map((l) => quotedOrPlain(l.slice(1).trim()))
        .filter(Boolean)
        .join(', ');
    }
    return contText.map(stripComment).filter(Boolean).join(' ');
  }

  if (/^[|>][+-]?\d*\s*(?:#.*)?$/.test(rest)) {
    // Block scalar: literal (|) keeps line breaks, folded (>) joins lines.
    return rest.startsWith('|') ? contText.join('\n') : contText.join(' ');
  }

  const joined = [rest, ...contText].join(' ');
  if (rest.startsWith('[')) {
    const close = joined.indexOf(']');
    const inner = close === -1 ? joined.slice(1) : joined.slice(1, close);
    return splitOutsideParens(inner, (ch) => ch === ',')
      .map((s) => quotedOrPlain(s.trim()))
      .filter(Boolean)
      .join(', ');
  }
  return quotedOrPlain(joined);
}

/**
 * Unquote a scalar that is entirely single- or double-quoted (a trailing
 * comment after the closing quote is allowed). Anything else is a plain
 * scalar: only a ` # comment` is removed. Text after a closing quote other
 * than a comment means the value is not a quoted scalar at all (e.g.
 * `description: "ship it" triggers a deploy`), so it is kept verbatim.
 */
function quotedOrPlain(text: string): string {
  const q = text[0];
  if (q === '"' || q === "'") {
    const parsed = q === '"' ? readDoubleQuoted(text) : readSingleQuoted(text);
    if (parsed && /^\s*(?:#.*)?$/.test(text.slice(parsed.end))) return parsed.value;
  }
  return stripComment(text);
}

const DOUBLE_QUOTE_ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  '0': '\0',
  '"': '"',
  '\\': '\\',
  '/': '/',
  ' ': ' ',
};

function readDoubleQuoted(text: string): { value: string; end: number } | null {
  let value = '';
  for (let i = 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') return { value, end: i + 1 };
    if (ch === '\\' && i + 1 < text.length) {
      const next = text[++i];
      value += DOUBLE_QUOTE_ESCAPES[next] ?? next;
      continue;
    }
    value += ch;
  }
  return null;
}

function readSingleQuoted(text: string): { value: string; end: number } | null {
  let value = '';
  for (let i = 1; i < text.length; i++) {
    if (text[i] !== "'") {
      value += text[i];
      continue;
    }
    if (text[i + 1] === "'") {
      value += "'";
      i++;
      continue;
    }
    return { value, end: i + 1 };
  }
  return null;
}

/** Split on separator characters that are not inside parentheses. */
function splitOutsideParens(text: string, isSeparator: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && isSeparator(ch)) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// --- Rule 1: missing frontmatter ---------------------------------------------

function checkMissingFrontmatter(file: SkillFile, fm: Frontmatter): LintIssue[] {
  if (fm.unclosed) {
    return [
      {
        severity: 'error',
        check: 'skill-frontmatter',
        ruleId: 'skill/missing-frontmatter',
        line: 1,
        message: `${file.displayPath}: frontmatter opens with \`---\` but is never closed`,
        suggestion: 'Add a matching `---` line after the last frontmatter field.',
      },
    ];
  }
  if (!fm.found) {
    if (file.kind === 'skill') {
      return [
        {
          severity: 'info',
          check: 'skill-frontmatter',
          ruleId: 'skill/missing-frontmatter',
          line: 1,
          message: `${file.displayPath}: no YAML frontmatter`,
          suggestion:
            'Claude Code uses the first non-empty line of the body as the description — add a `description` field saying when to use the skill.',
        },
      ];
    }
    return [
      {
        severity: 'error',
        check: 'skill-frontmatter',
        ruleId: 'skill/missing-frontmatter',
        line: 1,
        message: `${file.displayPath}: missing YAML frontmatter`,
        suggestion: `Add frontmatter with ${REQUIRED_FIELDS[file.kind].join(' + ')}.`,
      },
    ];
  }
  const issues: LintIssue[] = [];
  for (const field of REQUIRED_FIELDS[file.kind]) {
    if (!fm.fields[field]) {
      issues.push({
        severity: 'warning',
        check: 'skill-frontmatter',
        ruleId: 'skill/missing-frontmatter',
        line: 1,
        message: `${file.displayPath}: missing required frontmatter field "${field}"`,
        suggestion:
          field === 'description'
            ? 'Claude Code requires a description for an agent and uses it to decide when to delegate — add one describing when to use it.'
            : `Add a "${field}" field to the frontmatter.`,
      });
    }
  }
  for (const field of RECOMMENDED_FIELDS[file.kind]) {
    if (!fm.fields[field]) {
      issues.push({
        severity: 'info',
        check: 'skill-frontmatter',
        ruleId: 'skill/missing-frontmatter',
        line: 1,
        message: `${file.displayPath}: missing recommended frontmatter field "${field}"`,
        suggestion:
          'Without a description Claude Code falls back to the first non-empty body line, which rarely says when to use the skill — add one.',
      });
    }
  }
  return issues;
}

// --- Rule 2: broken path refs in the body ------------------------------------

// Explicitly-relative refs (./ ../) in prose. A bare `foo/bar` is too
// ambiguous to resolve against the skill dir without false positives, so it
// is not matched at all. Inline code spans are masked out of the prose scan
// and judged separately (see inlineCodeRef).
const BODY_PATH = /(?:^|[\s"'(])(\.{1,2}\/[\w@./-]+)(?=[\s"'),;:]|$)/gm;

// An inline code span counts as a path reference only when it is a single
// path token with a file extension or a trailing slash (`./notes.md`,
// `../shared/`). Anything else is a command: `./gradlew build`, `cd ../x`.
const INLINE_PATH = /^\.{1,2}\/[\w@./-]*(?:\.[A-Za-z0-9]+|\/)$/;
// ...and not one the prose says to run ("Run `./scripts/build.sh`").
const INVOCATION_BEFORE =
  /\b(?:run|runs|running|execute|executes|invoke|invokes|call|calls|launch|start)\b[^.;:!?]*$/i;
// The invocation guard applies only to executable-shaped spans. A document,
// data file or directory (`./guide.md`, `./x.json`, `./dir/`) is never run,
// so "Before you start, read `./guide.md`" is still a reference.
const EXECUTABLE_EXT =
  /\.(?:sh|bash|zsh|fish|py|js|mjs|cjs|ts|mts|cts|rb|pl|php|ps1|psm1|bat|cmd|exe|jar)$/i;

function inlineCodeRef(line: string, start: number, content: string): string | null {
  const value = content.trim();
  if (!INLINE_PATH.test(value)) return null;
  if (
    EXECUTABLE_EXT.test(value) &&
    INVOCATION_BEFORE.test(line.slice(Math.max(0, start - 40), start))
  ) {
    return null;
  }
  return value;
}

function checkBrokenRefs(file: SkillFile, fmEndLine: number): LintIssue[] {
  const issues: LintIssue[] = [];
  const skillDir = path.dirname(file.filePath);
  const lines = file.content.split(/\r?\n/);
  const body = lines.slice(fmEndLine);
  // Shared fence/comment classifier (``` and ~~~, CommonMark length matching).
  const classes = classifyLines(body);
  // The open fence's delimiter, so its closer can be recognised locally:
  // classifyLines only marks lines as fence, and a closer followed directly by
  // the next fence's opener is two adjacent fence lines.
  let open: { char: string; length: number } | null = null;
  let fenceLang = '';

  const report = (lineNo: number, value: string): void => {
    while (/[.,;:]$/.test(value)) value = value.slice(0, -1);
    const resolved = path.resolve(skillDir, value);
    if (fileExists(resolved) || isDirectory(resolved)) return;
    issues.push({
      severity: 'warning',
      check: 'skill-broken-ref',
      ruleId: 'skill/broken-ref',
      line: lineNo,
      message: `${file.displayPath}: references "${value}" which does not exist relative to the skill directory`,
      suggestion: 'Fix the path, or use a path that exists relative to the skill/agent file.',
    });
  };

  for (let k = 0; k < body.length; k++) {
    const raw = body[k];
    const lineNo = fmEndLine + k + 1;
    const cls = classes[k];
    if (cls.comment) continue; // commentary, never shown to the model as an instruction
    if (cls.fence) {
      const trimmed = raw.trimStart();
      if (!open) {
        // Opening delimiter: remember its shape and the info string's language.
        const delim = /^(?:`{3,}|~{3,})/.exec(trimmed)?.[0] ?? '```';
        open = { char: delim[0], length: delim.length };
        fenceLang = trimmed.slice(delim.length).trim().split(/\s+/)[0].toLowerCase();
        continue;
      }
      // Closing delimiter (same rule as markdown.ts closesFence): the opener's
      // character, at least as long, nothing but whitespace after.
      const closer = /^(`+|~+)\s*$/.exec(trimmed);
      if (closer && closer[1][0] === open.char && closer[1].length >= open.length) {
        open = null;
        fenceLang = '';
        continue;
      }
      // Skip code blocks that hold example source in a programming language
      // (same exclusion the context parser uses) -- a `./foo` inside a TS
      // snippet is an import example. Unlabeled fences are skipped too: a bare
      // fence is the most common way authors paste shell snippets, so a
      // `./run.sh 1.2.3` inside one is an invocation example, not a
      // skill-relative path. Matches the rule's "prefer a false negative over
      // a false positive" posture. The context parser (parser.ts
      // isExampleCodeBlock) deliberately diverges -- it DOES extract from bare
      // fences, where file trees and config layouts dominate.
      if (fenceLang === '' || isExampleLang(fenceLang)) continue;
    } else {
      open = null;
      fenceLang = '';
    }

    const spans = inlineCodeSpans(raw);
    for (const span of spans) {
      const value = inlineCodeRef(raw, span.start, span.content);
      if (value) report(lineNo, value);
    }

    const prose = maskCodeSpans(raw, spans);
    BODY_PATH.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BODY_PATH.exec(prose)) !== null) report(lineNo, m[1]);
  }
  return issues;
}

function isExampleLang(lang: string): boolean {
  return [
    'js',
    'javascript',
    'ts',
    'typescript',
    'tsx',
    'jsx',
    'py',
    'python',
    'go',
    'rust',
    'java',
    'c',
    'cpp',
    'ruby',
    'php',
    'json',
    'yaml',
    'yml',
    'toml',
    // Shell fences hold command/example snippets, not in-repo refs. A `./foo.sh`
    // inside a bash block is an invocation example (often a cross-repo script or
    // a placeholder), not a path that should resolve relative to the skill dir.
    // Matches the rule's "prefer a false negative over a false positive" posture.
    'bash',
    'sh',
    'shell',
    'shellscript',
    'zsh',
    'console',
  ].includes(lang);
}

// --- Rule 3: trigger-phrase collisions ---------------------------------------

// A quoted phrase introduced by a negation ('Not for "general questions"',
// 'Do not use for "x"') says when the skill must NOT fire, so it is not a
// trigger. The look-back for a negation stops at the previous quoted phrase
// and at any clause separator (. ; ! ? , -- —), so in
// 'Not "build only" -- also on "cut a release"' the second phrase is still a
// trigger. A negation does carry through a list: a phrase joined to a negated
// one by list glue alone (',', 'or', 'and', 'nor') is negated too, so every
// item of 'Not for "a", "b", or "c"' is excluded.
const NEGATION = /(?:\b(?:not|never|avoid|except|unless|instead\s+of|rather\s+than)\b|n['’]t\b)/i;
const CLAUSE_SEPARATOR = /[.;!?,—–]|--/g;
const NEGATION_WINDOW = 40;
const LIST_GLUE = /^[\s,]*(?:(?:or|and|nor)\b[\s,]*)?$/i;

function negatedQuote(
  desc: string,
  quoteAt: number,
  prevQuoteEnd: number,
  prevNegated: boolean,
): boolean {
  if (prevNegated && prevQuoteEnd > 0 && LIST_GLUE.test(desc.slice(prevQuoteEnd, quoteAt))) {
    return true;
  }
  let before = desc.slice(Math.max(0, quoteAt - NEGATION_WINDOW, prevQuoteEnd), quoteAt);
  const parts = before.split(CLAUSE_SEPARATOR);
  before = parts[parts.length - 1];
  return NEGATION.test(before);
}

/**
 * Extract candidate trigger phrases from a skill/agent's frontmatter. Claude
 * Code skills express triggers in the `description` (quoted phrases) and an
 * optional `trigger`/`triggers` field. We pull quoted phrases plus any explicit
 * trigger field values and normalize for comparison. The description is the
 * already-unquoted/unescaped scalar, so the YAML quoting around the whole value
 * never pairs with a quote inside it.
 */
function extractTriggers(fm: Frontmatter): string[] {
  const phrases = new Set<string>();
  const desc = fm.fields['description'] ?? '';
  // Quoted phrases inside the description ("ship 1.3.X", 'release X.Y.Z').
  // Double quotes pair freely; single quotes must sit on non-word boundaries
  // so apostrophes in contractions/possessives ("the user's branch can't
  // merge") aren't read as phrase delimiters -- a naive [\"'] class extracted
  // phantom triggers like "s branch can" and could shift the scan past a real
  // double-quoted trigger that followed a contraction.
  let prevQuoteEnd = 0;
  let prevNegated = false;
  for (const q of desc.matchAll(/"([^"]{3,})"|(?:^|\W)'([^']{3,})'(?!\w)/g)) {
    const quoteAt = q.index + q[0].indexOf(q[1] === undefined ? "'" : '"');
    const negated = negatedQuote(desc, quoteAt, prevQuoteEnd, prevNegated);
    prevQuoteEnd = q.index + q[0].length;
    prevNegated = negated;
    if (negated) continue;
    phrases.add(normalizeTrigger(q[1] ?? q[2]));
  }
  for (const key of ['trigger', 'triggers']) {
    const val = fm.fields[key];
    if (val) for (const part of val.split(',')) phrases.add(normalizeTrigger(part));
  }
  phrases.delete('');
  return [...phrases];
}

function normalizeTrigger(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

function checkTriggerCollisions(parsed: { file: SkillFile; fm: Frontmatter }[]): LintIssue[] {
  const byTrigger = new Map<string, SkillFile[]>();
  for (const { file, fm } of parsed) {
    for (const t of extractTriggers(fm)) {
      const list = byTrigger.get(t) ?? [];
      list.push(file);
      byTrigger.set(t, list);
    }
  }
  const issues: LintIssue[] = [];
  for (const [trigger, owners] of byTrigger) {
    const distinct = [...new Set(owners.map((o) => o.displayPath))];
    if (distinct.length > 1) {
      issues.push({
        severity: 'warning',
        check: 'skill-trigger-collision',
        ruleId: 'skill/trigger-collision',
        line: 1,
        message: `Trigger phrase "${trigger}" is declared by ${distinct.length} skills/agents — only one will win`,
        detail: distinct.map((d) => `  - ${d}`).join('\n'),
        suggestion: 'Make trigger phrases unique so invocation is deterministic.',
      });
    }
  }
  return issues;
}

// --- Rule 4: orphaned skills (no SKILL.md) -----------------------------------

function checkOrphaned(ctx: SkillContext): LintIssue[] {
  return ctx.orphanedSkillDirs.map((o) => ({
    severity: 'warning' as const,
    check: 'skill-orphaned' as const,
    ruleId: 'skill/orphaned',
    line: 1,
    message: `${o.displayPath}: skill directory has no SKILL.md — Claude Code has nothing to load`,
    suggestion: `Add a SKILL.md, or remove the empty ${o.displayPath} directory.`,
  }));
}

// --- Rule 5: dead tool-restriction refs --------------------------------------

// Built-in Claude Code tool names a tool restriction may list. MCP tools are
// namespaced `mcp__<server>__<tool>` and are NOT validated here (their
// existence depends on the loaded MCP servers, which we can't see) -- only
// obviously-misspelled BUILT-IN tool names are flagged.
//
// Validated against the tools table at code.claude.com/docs/en/tools-reference
// on 2026-11-22. To refresh: re-read that table and ADD any new names. Prefer
// adding over removing -- a tool dropped from Claude Code may still be listed
// in older agent files, where flagging it would be noise -- so the legacy
// names below stay (TaskOutput is documented as removed in v2.1.277; Task was
// the Agent tool's old name; BashOutput / KillShell / LS / MultiEdit /
// NotebookRead / SlashCommand predate the current table). Names not in this
// set that still LOOK like built-ins (PascalCase) are reported as info, not
// warning -- see checkDeadToolRestrictions.
const KNOWN_TOOLS = new Set([
  // Current tools-reference table.
  'Agent',
  'Artifact',
  'AskUserQuestion',
  'Bash',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EndConversation',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'ListAgents',
  'ListMcpResourcesTool',
  'ListPlugins',
  'ListSkills',
  'LSP',
  'Monitor',
  'NotebookEdit',
  'PowerShell',
  'propose_skills',
  'PushNotification',
  'Read',
  'ReadMcpResourceTool',
  'RemoteTrigger',
  'ReportFindings',
  'ScheduleWakeup',
  'SearchPlugins',
  'SearchSkills',
  'SendFeedback',
  'SendMessage',
  'SendUserFile',
  'ShareOnboardingGuide',
  'Skill',
  'SubagentHandback',
  'SuggestPluginInstall',
  'SuggestSkills',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WaitForMcpServers',
  'WebFetch',
  'WebSearch',
  'Workflow',
  'Write',
  // Legacy / SDK names still found in older agent files.
  'BashOutput',
  'KillShell',
  'LS',
  'MultiEdit',
  'NotebookRead',
  'SlashCommand',
  'StructuredOutput',
  'Task',
]);

const KNOWN_TOOLS_BY_LOWER = new Map([...KNOWN_TOOLS].map((t) => [t.toLowerCase(), t]));

const TOOLS_REFERENCE_URL = 'https://code.claude.com/docs/en/tools-reference';

// Which frontmatter keys restrict tools, per kind, and how each splits.
// Agents: `tools` / `disallowedTools`, "a comma-separated string such as
// `Read, Grep, Bash` or a YAML list". Skills: `allowed-tools` /
// `disallowed-tools`, "a space- or comma-separated string, or a YAML list".
// Commas or spaces inside parentheses belong to a permission specifier
// (`Bash(git add, git commit)`, `Bash(git add *)`) and never split.
const TOOL_KEYS: Record<
  SkillFile['kind'],
  { keys: string[]; isSeparator: (ch: string) => boolean }
> = {
  agent: { keys: ['tools', 'disallowedTools'], isSeparator: (ch) => ch === ',' },
  skill: { keys: ['allowed-tools', 'disallowed-tools'], isSeparator: (ch) => /[,\s]/.test(ch) },
};

function checkDeadToolRestrictions(file: SkillFile, fm: Frontmatter): LintIssue[] {
  const { keys, isSeparator } = TOOL_KEYS[file.kind];
  const issues: LintIssue[] = [];
  for (const key of keys) {
    const raw = fm.fields[key];
    if (!raw) continue;
    for (const item of splitOutsideParens(raw, isSeparator)) {
      const entry = quotedOrPlain(item);
      // Skip MCP-namespaced tools (mcp__server__tool) and wildcards -- can't verify.
      if (!entry || entry.startsWith('mcp__') || entry.includes('*')) continue;
      // A restriction may name a tool with an arg form, e.g. "Bash(git:*)".
      const base = entry.replace(/\(.*\)$/s, '').trim();
      if (KNOWN_TOOLS.has(base)) continue;
      // An unknown PascalCase name may be a built-in newer than KNOWN_TOOLS
      // (the list drifts stale across CC versions), so it's info; anything
      // else (lowercase, separators) doesn't match CC's naming and is far more
      // likely a typo, so it keeps the warning.
      const looksLikeBuiltin = /^[A-Z][A-Za-z]+$/.test(base);
      const caseMatch = KNOWN_TOOLS_BY_LOWER.get(base.toLowerCase());
      issues.push({
        severity: looksLikeBuiltin ? 'info' : 'warning',
        check: 'skill-dead-tool-restriction',
        ruleId: 'skill/dead-tool-restriction',
        line: 1,
        message: `${file.displayPath}: tool restriction lists "${entry}" which is not a known Claude Code tool`,
        suggestion: caseMatch
          ? `Did you mean "${caseMatch}"? Tool names are case-sensitive.`
          : `Use a built-in tool name (${TOOLS_REFERENCE_URL}), or the mcp__server__tool form for an MCP tool.`,
      });
    }
  }
  return issues;
}

// --- Orchestrator ------------------------------------------------------------

export interface SkillCheckSelection {
  frontmatter: boolean;
  brokenRef: boolean;
  triggerCollision: boolean;
  orphaned: boolean;
  deadToolRestriction: boolean;
}

export function checkSkills(ctx: SkillContext, sel: SkillCheckSelection): LintIssue[] {
  const issues: LintIssue[] = [];
  const parsed = ctx.files.map((file) => ({ file, fm: parseFrontmatter(file.content) }));

  for (const { file, fm } of parsed) {
    if (sel.frontmatter) issues.push(...checkMissingFrontmatter(file, fm));
    if (sel.brokenRef) issues.push(...checkBrokenRefs(file, fm.found ? fm.endLine : 0));
    if (sel.deadToolRestriction) issues.push(...checkDeadToolRestrictions(file, fm));
  }
  if (sel.triggerCollision) issues.push(...checkTriggerCollisions(parsed));
  if (sel.orphaned) issues.push(...checkOrphaned(ctx));

  return issues;
}
