// Parser for .ctxlintignore -- a per-project ignore-file for ctxlint findings.
//
// Format: one rule per line.
//   checkName [fileGlob] [# reason]
//   blank lines and lines starting with # are comments.
//
// Examples:
//   paths                          # ignore all paths findings
//   tokens CLAUDE.md               # ignore tokens findings only in CLAUDE.md
//   redundancy src/**              # ignore redundancy findings under src/
//   staleness docs/*.md # noisy   # inline reason stripped from the glob
//
// Rules are merged with config-based ignoreRules before applyIgnoreRules() is
// called in audit.ts. The _fileGlob property is extra state carried on the rule
// for the pre-filter pass in audit.ts; applyIgnoreRules() itself sees only the
// plain IgnoreRule fields (check / match / pathPattern / reason).
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { IgnoreRule } from './ignore-rules.js';
import type { CheckName } from './types.js';

/**
 * An ignore rule loaded from .ctxlintignore. Extends the base IgnoreRule
 * shape with an optional _fileGlob field that, when set, restricts the rule
 * to issues whose parent FileResult.path matches the glob.
 *
 * The _fileGlob field is consumed by audit.ts's pre-filter pass and is
 * invisible to applyIgnoreRules() (which only reads the plain IgnoreRule
 * fields). Rules without _fileGlob are passed through to applyIgnoreRules()
 * unchanged and fire against all files.
 */
export interface IgnoreFileRule extends IgnoreRule {
  /** Optional glob matched against FileResult.path (the relative path of the file being audited). */
  _fileGlob?: string;
}

/**
 * Test whether a file path matches a glob pattern.
 * Uses picomatch with { dot: true } so dotfiles (CLAUDE.md, .ctxlintrc, etc.)
 * are matched by patterns like `**` without needing an explicit dot prefix.
 */
export function matchesGlob(filePath: string, glob: string): boolean {
  return picomatch(glob, { dot: true })(filePath);
}

/**
 * Load and parse .ctxlintignore from projectRoot.
 * Returns [] when the file does not exist or is empty.
 * Silently skips lines that cannot be parsed as a valid rule.
 */
export function loadIgnoreFile(projectRoot: string): IgnoreFileRule[] {
  const ignoreFilePath = path.join(projectRoot, '.ctxlintignore');
  let content: string;
  try {
    content = fs.readFileSync(ignoreFilePath, 'utf-8');
  } catch {
    return [];
  }

  const rules: IgnoreFileRule[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Blank lines and full-line comments are skipped.
    if (!line || line.startsWith('#')) continue;

    // Strip inline comment: the first ` #` (space-hash) that is not at the
    // start of the line marks the boundary between the rule tokens and the
    // human-readable reason.
    const commentIdx = line.indexOf(' #');
    const reason = commentIdx >= 0 ? line.slice(commentIdx + 2).trim() : undefined;
    const ruleBody = (commentIdx >= 0 ? line.slice(0, commentIdx) : line).trim();

    // Tokenise: first token is the check name, optional second token is the
    // file glob. Additional tokens are silently ignored for forward compatibility.
    const tokens = ruleBody.split(/\s+/);
    const check = tokens[0] as CheckName;
    const fileGlob = tokens[1]; // may be undefined

    if (!check) continue;

    const rule: IgnoreFileRule = { check, reason };
    if (fileGlob) {
      rule._fileGlob = fileGlob;
    }

    rules.push(rule);
  }

  return rules;
}
