// Convert a character offset within a string to a 1-based { line, column }
// position. Used by JSON / JSONC parsers in this codebase to translate
// parser-reported byte offsets into the line/column shape humans (and
// editors / SARIF consumers) expect.
//
// Behavior matches the prior in-file implementation in
// `core/config.ts` (`posToLineCol`), which was merged here to avoid drift.
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
