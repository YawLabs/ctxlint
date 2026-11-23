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
 * Fences follow CommonMark matching (see classifyLines): ``` and ~~~ both
 * open a fence, and a closer must use the same character, be at least as long
 * as the opener, and carry no info string. classifyLines is the shared fence
 * scanner: parser.ts, skills.ts and suppressions.ts read it directly, and
 * cli-subcommands.ts and exit-status.ts read it through these masks.
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
 * findBinInvocations (cli-subcommands.ts) uses this mask for the same reason.
 */
export function htmlCommentLineMask(lines: string[]): boolean[] {
  return classifyLines(lines).map((c) => c.comment);
}

export interface LineClass {
  /** Inside a fenced code block, delimiter lines included. */
  fence: boolean;
  comment: boolean;
  /** The fence's opening or closing delimiter line (implies `fence`). */
  fenceDelimiter: boolean;
  /**
   * The enclosing fence's info string, trimmed but otherwise as written
   * (```` ```Bash title=x ```` gives `Bash title=x`), on every line of that
   * fence including both delimiters. Empty for a bare fence and outside fences.
   */
  fenceInfo: string;
}

/** An open fence: its character and run length (CommonMark section 4.5). */
interface OpenFence {
  char: '`' | '~';
  length: number;
  info: string;
}

/**
 * Parse a fence OPENER: 3+ backticks or tildes after optional indentation. A
 * backtick opener's info string may not contain a backtick -- that is what
 * keeps a one-line ```echo hi``` snippet (an inline code span) from opening a
 * fence and flipping state for the rest of the file.
 *
 * Indentation is deliberately not capped at CommonMark's 3 spaces: fences
 * nested in list items are indented further, and the masks would otherwise
 * read their content as prose.
 */
function parseFenceOpener(trimmed: string): OpenFence | null {
  const m = /^(`{3,}|~{3,})([^\n]*)$/.exec(trimmed); // [^\n], not ., so a CRLF line's \r still matches
  if (!m) return null;
  const char = m[1][0] as '`' | '~';
  if (char === '`' && m[2].includes('`')) return null;
  return { char, length: m[1].length, info: m[2].trim() };
}

/** A closer: the opener's character, at least as long, nothing but whitespace after. */
function closesFence(trimmed: string, fence: OpenFence): boolean {
  const m = /^(`+|~+)\s*$/.exec(trimmed);
  return m !== null && m[1][0] === fence.char && m[1].length >= fence.length;
}

/**
 * Single state machine behind both masks above, so the two can never disagree
 * about where a fence or comment starts. Exported so other modules can share
 * one classification instead of re-implementing fence/comment scanning.
 *
 * Nesting is decided by whichever construct opened FIRST:
 *   - a fence opened in prose wins: a `<!--` inside it is sample text;
 *   - a comment opened in prose wins: fence markers inside it are commented
 *     out (the lines are `comment`, not `fence`), and a `-->` on any of
 *     those lines closes the comment.
 */
export function classifyLines(lines: string[]): LineClass[] {
  const out: LineClass[] = lines.map(() => ({
    fence: false,
    comment: false,
    fenceDelimiter: false,
    fenceInfo: '',
  }));
  let fence: OpenFence | null = null;
  let inHtmlComment = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trimStart();

    if (fence) {
      out[i].fence = true;
      out[i].fenceInfo = fence.info;
      if (closesFence(trimmed, fence)) {
        out[i].fenceDelimiter = true;
        fence = null;
      }
      continue;
    }

    // Probe against a code-span-masked copy. A context file may legitimately
    // TALK about comment syntax -- "Use `<!--` to start an HTML comment" --
    // and a naive substring test opened a comment there and latched, masking
    // every line to the end of the file and silently dropping real findings.
    const probe = maskCodeSpans(trimmed, inlineCodeSpans(trimmed));

    // Checked BEFORE fence handling: inside a comment a fence marker is
    // commented-out text, so it must neither open a fence nor hide a `-->`.
    if (inHtmlComment) {
      out[i].comment = true;
      if (probe.includes('-->')) inHtmlComment = false;
      continue;
    }

    const opener = parseFenceOpener(trimmed);
    if (opener) {
      out[i].fence = true; // the delimiter line is not prose either
      out[i].fenceDelimiter = true;
      out[i].fenceInfo = opener.info;
      fence = opener;
      continue;
    }

    // Remove complete `<!-- ... -->` pairs before deciding. Only an UNCLOSED
    // opener puts the scanner into comment state; a line carrying just a
    // self-contained annotation stays prose, because the prose around it is
    // still addressed to the reader ("NEVER run `x`. <!-- reviewed 2026-08 -->"
    // is a real rule with a note appended, and masking the whole line lost it).
    // Callers that scan such a line should first blank the comment's own text
    // with stripInlineHtmlComments.
    //
    // Pairs are blanked with filler, not deleted: deleting splices the text on
    // either side together, so `<!<!-- x -->-- y` would synthesize a `<!--`
    // that was never written and latch the rest of the file as comment.
    if (HTML_COMMENT.test(stripInlineHtmlComments(probe))) {
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
  // Repeated to a fixed point. Because the filler is length-preserving and
  // contains neither `<!--` nor `-->`, it cannot create a new pair, so the
  // second pass always finds nothing and the result equals a single pass. The
  // loop makes the guarantee hold without relying on that argument (and is the
  // shape CodeQL's js/incomplete-multi-character-sanitization recognises).
  let out = line;
  let previous: string;
  do {
    previous = out;
    out = out.replace(HTML_COMMENT_PAIR, (m) => '#'.repeat(m.length));
  } while (out !== previous);
  return out;
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

/**
 * The one closing-fence rule for YAML frontmatter, shared by every frontmatter
 * reader so they cannot disagree about where the block ends.
 *
 * The fence must start at column 0 to match the host loaders (gray-matter /
 * Cursor): an indented `   ---` does NOT close the frontmatter. Trailing
 * whitespace is harmless and is ignored, as is a CRLF line's `\r`.
 */
export function isFrontmatterFence(line: string): boolean {
  return line.trimEnd() === '---';
}
