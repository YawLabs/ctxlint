// Convert a character offset within a string to a 1-based { line, column }
// position. Used by JSON / JSONC parsers in this codebase to translate
// parser-reported byte offsets into the line/column shape humans (and
// editors / SARIF consumers) expect.
//
// Behavior matches the prior in-file implementation in
// `core/config.ts` (`posToLineCol`), which was merged here to avoid drift.
//
// Cost: each call rescans `content` from index 0, so mapping M offsets in an
// N-char file is O(N*M). Current callers map one offset per parse error /
// hook node; a caller mapping many offsets in a large file should precompute
// line starts instead of calling this in a loop.
//
// Semantics worth knowing: offsets past content.length clamp to the position
// just after the last character; only '\n' starts a new line, so the '\r' of
// a CRLF pair counts toward the column of the line it ends.
export function offsetToPosition(
  content: string,
  offset: number,
): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
