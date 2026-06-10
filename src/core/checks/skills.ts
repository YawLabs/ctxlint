import * as path from 'node:path';
import { fileExists, isDirectory } from '../../utils/fs.js';
import type { LintIssue, SkillContext, SkillFile } from '../types.js';

/**
 * Agent-skill linting (fourth pillar, v1). Lints Claude Code skill + agent
 * definition files under ~/.claude (see AGENT_SKILL_LINT_SPEC.md). Rules:
 *
 *  - skill/missing-frontmatter   — required frontmatter fields absent
 *  - skill/broken-ref            — a path/command reference in the body that
 *                                  doesn't resolve (reuses the path/command
 *                                  detection shape from the context pillar)
 *  - skill/trigger-collision     — two skills declare the same trigger phrase
 *  - skill/orphaned              — a skills/<name>/ dir with no SKILL.md
 *  - skill/dead-tool-restriction — an agent's tool restriction references a
 *                                  tool name that isn't a known Claude Code tool
 *
 * v1 is intentionally tight: Claude-Code-only, conservative heuristics.
 */

// Required frontmatter fields per kind. Claude Code skills + agents both key
// off `name` + `description`; the description is also what drives invocation,
// so a missing description is a real "this never fires" bug.
const REQUIRED_FIELDS: Record<SkillFile['kind'], string[]> = {
  skill: ['name', 'description'],
  agent: ['name', 'description'],
};

interface Frontmatter {
  found: boolean;
  unclosed: boolean;
  /** Scalar fields (key -> raw value). Array values are joined with ", ". */
  fields: Record<string, string>;
  /** 1-indexed line the closing `---` sits on (or content length if unclosed). */
  endLine: number;
}

/**
 * Minimal YAML-frontmatter parser (same shape as core/checks/frontmatter.ts,
 * inlined to avoid widening that module's API). Handles `key: value`, empty
 * keys leading a `- item` array, and inline `[a, b]` arrays.
 */
function parseFrontmatter(content: string): Frontmatter {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { found: false, unclosed: false, fields: {}, endLine: 0 };
  }
  const fields: Record<string, string> = {};
  let arrayKey = '';
  let endLine = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === '---') {
      endLine = i + 1;
      break;
    }
    if (line.startsWith('- ') && arrayKey) {
      const item = line
        .slice(2)
        .trim()
        .replace(/^["']|["']$/g, '');
      fields[arrayKey] = fields[arrayKey] ? `${fields[arrayKey]}, ${item}` : item;
      continue;
    }
    arrayKey = '';
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (m) {
      let val = m[2].trim();
      // Inline array `[a, b]` -> "a, b".
      const inline = val.match(/^\[(.*)\]$/);
      if (inline) {
        val = inline[1]
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean)
          .join(', ');
      }
      fields[m[1]] = val;
      if (!m[2].trim()) arrayKey = m[1];
    }
  }
  if (endLine === 0) return { found: true, unclosed: true, fields, endLine: lines.length };
  return { found: true, unclosed: false, fields, endLine };
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
            ? 'A skill/agent with no description is never selected — add one describing when to use it.'
            : `Add a "${field}" field to the frontmatter.`,
      });
    }
  }
  return issues;
}

// --- Rule 2: broken path/command refs in the body ----------------------------

// Conservative path detector: a token with a path separator that points at a
// real-looking file/dir reference. Mirrors the context pillar's intent without
// re-running the full markdown parser (skills are small, self-contained files).
const BODY_PATH = /(?:^|[\s`"'(])((?:\.{1,2}\/)[\w@./-]+|(?:[\w@-]+\/)+[\w.-]+)(?=[\s`"'),;:]|$)/gm;
const PATH_SKIP = /^(https?:\/\/|mailto:|n\/a|e\.g\.|i\.e\.)/i;

function checkBrokenRefs(file: SkillFile, fmEndLine: number): LintIssue[] {
  const issues: LintIssue[] = [];
  const skillDir = path.dirname(file.filePath);
  const lines = file.content.split('\n');
  let inCode = false;
  let codeLang = '';

  for (let i = 0; i < lines.length; i++) {
    if (i + 1 <= fmEndLine) continue; // skip frontmatter region
    const raw = lines[i];
    if (raw.trimStart().startsWith('```')) {
      inCode = !inCode;
      codeLang = inCode ? raw.trimStart().slice(3).trim().toLowerCase() : '';
      continue;
    }
    // Only flag refs that look like in-repo paths. Skip code blocks that hold
    // example source in a programming language (same exclusion the context
    // parser uses) -- a `./foo` inside a TS snippet is an import example.
    // Unlabeled ``` fences are skipped too: a bare fence is the most common
    // way authors paste shell snippets, so a `./run.sh 1.2.3` inside one is
    // an invocation example, not a skill-relative path. Matches the rule's
    // "prefer a false negative over a false positive" posture.
    if (inCode && (codeLang === '' || isExampleLang(codeLang))) continue;

    BODY_PATH.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BODY_PATH.exec(raw)) !== null) {
      let value = m[1];
      if (PATH_SKIP.test(value)) continue;
      // Only verify explicitly-relative refs (./ ../). A bare `foo/bar` in prose
      // is too ambiguous to resolve against the skill dir without false positives.
      if (!value.startsWith('./') && !value.startsWith('../')) continue;
      while (/[.,;:]$/.test(value)) value = value.slice(0, -1);
      const resolved = path.resolve(skillDir, value);
      if (fileExists(resolved) || isDirectory(resolved)) continue;
      issues.push({
        severity: 'warning',
        check: 'skill-broken-ref',
        ruleId: 'skill/broken-ref',
        line: i + 1,
        message: `${file.displayPath}: references "${value}" which does not exist relative to the skill directory`,
        suggestion: 'Fix the path, or use a path that exists relative to the skill/agent file.',
      });
    }
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

/**
 * Extract candidate trigger phrases from a skill/agent's frontmatter. Claude
 * Code skills express triggers in the `description` (quoted phrases) and an
 * optional `trigger`/`triggers` field. We pull quoted phrases plus any explicit
 * trigger field values and normalize for comparison.
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
  for (const q of desc.matchAll(/"([^"]{3,})"|(?:^|\W)'([^']{3,})'(?!\w)/g)) {
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

// Built-in Claude Code tool names an agent's `tools:` restriction may list.
// MCP tools are namespaced `mcp__<server>__<tool>` and are NOT validated here
// (their existence depends on the loaded MCP servers, which we can't see) --
// only obviously-misspelled BUILT-IN tool names are flagged.
//
// Validated against the Claude Code built-in tool list on 2026-06-09. CC's
// built-ins drift across versions: refresh this set when revalidating, and
// prefer adding over removing (a tool dropped from CC may still be listed in
// older agent files, where flagging it would be noise). Names not in this set
// that still LOOK like built-ins (PascalCase) are reported as info, not
// warning -- see checkDeadToolRestrictions.
const KNOWN_TOOLS = new Set([
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResourcesTool',
  'MultiEdit',
  'NotebookEdit',
  'Read',
  'ReadMcpResourceTool',
  'Skill',
  'SlashCommand',
  'StructuredOutput',
  'Task',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
]);

function checkDeadToolRestrictions(file: SkillFile, fm: Frontmatter): LintIssue[] {
  if (file.kind !== 'agent') return [];
  const raw = fm.fields['tools'] ?? fm.fields['allowed-tools'] ?? fm.fields['allowedTools'];
  if (!raw) return [];
  const issues: LintIssue[] = [];
  for (const entry of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    // Skip MCP-namespaced tools (mcp__server__tool) and wildcards -- can't verify.
    if (entry.startsWith('mcp__') || entry.includes('*')) continue;
    // A restriction may name a tool with an arg form, e.g. "Bash(git:*)".
    const base = entry.replace(/\(.*\)$/, '').trim();
    if (KNOWN_TOOLS.has(base)) continue;
    // An unknown PascalCase name may be a built-in newer than KNOWN_TOOLS
    // (the list drifts stale across CC versions), so it's info; anything
    // else (lowercase, separators) doesn't match CC's naming and is far more
    // likely a typo, so it keeps the warning.
    const looksLikeBuiltin = /^[A-Z][A-Za-z]+$/.test(base);
    issues.push({
      severity: looksLikeBuiltin ? 'info' : 'warning',
      check: 'skill-dead-tool-restriction',
      ruleId: 'skill/dead-tool-restriction',
      line: 1,
      message: `${file.displayPath}: tool restriction lists "${entry}" which is not a known Claude Code tool`,
      suggestion: `Known built-in tools: ${[...KNOWN_TOOLS].join(', ')}. MCP tools use the mcp__server__tool form.`,
    });
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
