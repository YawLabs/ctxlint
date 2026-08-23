/**
 * Markdown-lexical primitives shared by the checks.
 *
 * These live in utils/ rather than inside a check because more than one check
 * needs them and a check importing another check couples two rule modules that
 * are otherwise independent (tier-tokens <- commands was the first instance).
 * Nothing here knows about rules, severities, or findings -- it is pure string
 * lexing over a markdown line array.
 */

export interface CodeSpan {
  start: number;
  end: number;
  content: string;
}

/**
 * Inline code spans (`` `like this` ``) on a single line, in source order.
 * `start`/`end` bracket the span INCLUDING both backticks, so
 * `line.slice(start, end)` round-trips.
 *
 * Single-backtick only: the doubled form (`` ``a ` b`` ``) is not recognized,
 * matching every other backtick scan in this codebase. A doubled span degrades
 * to "no span found" (conservative -- see maskCodeSpans callers, which lose a
 * masking opportunity rather than gaining a false one).
 */
export function inlineCodeSpans(line: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length, content: m[1] });
  }
  return spans;
}

/**
 * Blank out code spans (backticks included) so a prose search can't see them.
 * The filler is `#`, not a space: a space filler would let "do `x` not" mask
 * into "do     not" and MATCH `do\s+not`, manufacturing framing that isn't in
 * the prose. `#` is non-word, non-space, and not a sentence terminator, so it
 * can neither complete a framing token nor fail a same-sentence gap test.
 *
 * Length-preserving, so column indices computed against the raw line stay
 * valid against the masked one.
 */
export function maskCodeSpans(line: string, spans: CodeSpan[]): string {
  let out = line;
  for (const s of spans) {
    out = out.slice(0, s.start) + '#'.repeat(s.end - s.start) + out.slice(s.end);
  }
  return out;
}

/**
 * Per-line mask marking every line that is NOT prose addressed to the reader:
 * fenced code blocks (the ``` delimiters and everything between them) and HTML
 * comments.
 *
 * Why checks want this: a fenced block in a context file is an ILLUSTRATION.
 * A rule that scans raw lines for directive prose will read
 * "NEVER run `terraform apply`" out of a ```markdown fence that exists to SHOW
 * the reader what such a rule looks like, and report the example as if it were
 * the repo's own policy. HTML comments are the same class -- they carry
 * commentary ABOUT a command rather than an instruction to run it (and Claude
 * Code strips block-level HTML comments before injecting a context file, so
 * their content never reaches the agent at all).
 *
 * Deliberately language-agnostic: unlike `isExampleCodeBlock` in parser.ts,
 * which keeps bare and shell fences because they hold real path/command
 * references worth validating, prose-framing checks want EVERY fence skipped.
 * A directive can only be written in prose, so a fenced line is never a
 * legitimate hit regardless of its info string.
 *
 * An unterminated fence or comment masks the remainder of the file. That is
 * the conservative direction (fewer findings, never a fabricated one), which
 * matches the false-negative-over-false-positive posture of the callers.
 *
 * Recognizes ``` fences only, not ~~~ -- consistent with parser.ts and
 * cli-subcommands.ts, the other two fence scanners in this codebase.
 */
export function nonProseLineMask(lines: string[]): boolean[] {
  return classifyLines(lines).map((c) => c.fence || c.comment);
}

/**
 * Comment-only view of the same scan: true for lines inside (or opening) an
 * HTML comment, false for everything else INCLUDING fenced code.
 *
 * Callers that legitimately read fenced content want this rather than
 * nonProseLineMask. checkCommands is the case: the parser deliberately
 * extracts command references from shell fences, so masking fences there would
 * blind the whole check -- but a command written inside an HTML comment is
 * commentary ABOUT a command, not one to run, and linting it produced findings
 * on commented-out notes ("<!-- we used to run `npx old-tool` here -->").
 * findBinInvocations reached the same conclusion independently.
 */
export function htmlCommentLineMask(lines: string[]): boolean[] {
  return classifyLines(lines).map((c) => c.comment);
}

interface LineClass {
  fence: boolean;
  comment: boolean;
}

/**
 * Single state machine behind both masks above, so the two can never disagree
 * about where a fence or comment starts.
 */
function classifyLines(lines: string[]): LineClass[] {
  const out: LineClass[] = lines.map(() => ({ fence: false, comment: false }));
  let inFence = false;
  let inHtmlComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();

    // Fence state wins over comment state: a `<!--` written inside a fenced
    // block is sample text, not a comment opener.
    if (trimmed.startsWith('```')) {
      out[i].fence = true; // the delimiter line is not prose either
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out[i].fence = true;
      continue;
    }

    // Probe against a code-span-masked copy. A context file may legitimately
    // TALK about comment syntax -- "Use `<!--` to start an HTML comment" --
    // and a naive substring test opened a comment there and latched, masking
    // every line to the end of the file and silently dropping real findings.
    const probe = maskCodeSpans(trimmed, inlineCodeSpans(trimmed));

    if (inHtmlComment) {
      out[i].comment = true;
      if (probe.includes('-->')) inHtmlComment = false;
      continue;
    }

    // Remove complete `<!-- ... -->` pairs before deciding. Only an UNCLOSED
    // opener puts the scanner into comment state; a line carrying just a
    // self-contained annotation stays prose, because the prose around it is
    // still addressed to the reader ("NEVER run `x`. <!-- reviewed 2026-08 -->"
    // is a real rule with a note appended, and masking the whole line lost it).
    // Callers that scan such a line should first blank the comment's own text
    // with stripInlineHtmlComments.
    if (HTML_COMMENT.test(probe.replace(HTML_COMMENT_PAIR, ''))) {
      out[i].comment = true;
      inHtmlComment = true;
    }
  }
  return out;
}

/** A complete, self-contained HTML comment. */
const HTML_COMMENT_PAIR = /<!--[\s\S]*?-->/g;
/** A bare opener (used only after complete pairs have been removed). */
const HTML_COMMENT = /<!--/;

/**
 * Blank the contents of complete `<!-- ... -->` comments on a line, backticks
 * of the markers included, with length-preserving `#` filler.
 *
 * Pairs with nonProseLineMask: that reports which LINES are wholly non-prose,
 * which cannot express "this line is prose except for a trailing annotation".
 * A caller scanning a prose line runs it through this first so a comment's own
 * text cannot be read as an instruction.
 */
export function stripInlineHtmlComments(line: string): string {
  return line.replace(HTML_COMMENT_PAIR, (m) => '#'.repeat(m.length));
}

/**
 * Character ranges of complete `<!-- ... -->` comments on a line, markers
 * included.
 *
 * The third granularity, needed because the other two cannot express "this
 * line is prose, but THIS position on it is not". htmlCommentLineMask
 * deliberately leaves a self-contained comment's line unmasked (the prose
 * around it still counts), so a caller holding a column -- a command reference,
 * say -- has to ask whether that specific offset falls inside a comment.
 *
 * Uses its own regex instance: the module-level one carries the `g` flag, and
 * sharing `lastIndex` across callers makes results depend on call order.
 */
export function htmlCommentSpans(line: string): Array<{ start: number; end: number }> {
  const re = /<!--[\s\S]*?-->/g;
  const spans: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    spans.push({ start: m.index, end: m.index + m[0].length });
  }
  return spans;
}
