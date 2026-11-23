import { describe, it, expect } from 'vitest';
import {
  inlineCodeSpans,
  maskCodeSpans,
  nonProseLineMask,
  stripInlineHtmlComments,
  classifyLines,
  htmlCommentLineMask,
  htmlCommentSpans,
  isFrontmatterFence,
} from '../markdown.js';

describe('inlineCodeSpans', () => {
  it('brackets each span including both backticks so slice round-trips', () => {
    const line = 'run `npm ci` then `npm test` here';
    const spans = inlineCodeSpans(line);
    expect(spans.map((s) => s.content)).toEqual(['npm ci', 'npm test']);
    expect(line.slice(spans[0].start, spans[0].end)).toBe('`npm ci`');
    expect(line.slice(spans[1].start, spans[1].end)).toBe('`npm test`');
  });

  it('returns nothing for a line with no spans or an unclosed backtick', () => {
    expect(inlineCodeSpans('plain prose')).toEqual([]);
    expect(inlineCodeSpans('an `unclosed span')).toEqual([]);
  });
});

describe('maskCodeSpans', () => {
  it('preserves length so offsets stay valid', () => {
    const line = 'run `npm ci` now';
    expect(maskCodeSpans(line, inlineCodeSpans(line))).toHaveLength(line.length);
  });

  it('fills with # so masking cannot manufacture a framing token', () => {
    // A space filler would collapse "do `x` not" into "do     not", which
    // matches /do\s+not/ -- framing that is not in the prose.
    const line = 'do `x` not';
    const masked = maskCodeSpans(line, inlineCodeSpans(line));
    expect(masked).toBe('do ### not');
    expect(/do\s+not/.test(masked)).toBe(false);
  });

  // The loop rewrites `out` while every span offset was computed against the
  // ORIGINAL line, so correctness rests entirely on each replacement being
  // length-preserving. With one span that invariant is invisible; with two, a
  // non-preserving replacement shifts the second span and corrupts the result.
  it('masks every span on a line, keeping later offsets valid', () => {
    const line = 'run `a` and `bb` now';
    expect(maskCodeSpans(line, inlineCodeSpans(line))).toBe('run ### and #### now');
  });
});

describe('nonProseLineMask', () => {
  const mask = (md: string) => nonProseLineMask(md.split('\n'));

  it('masks fence delimiters and everything between them', () => {
    // 0: prose  1: ```md  2: body  3: ```  4: prose
    expect(mask('prose\n```markdown\nNEVER run `x`\n```\nafter')).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it('toggles off after a closed fence rather than latching', () => {
    const m = mask('```bash\nnpm ci\n```\nprose again');
    expect(m[3]).toBe(false);
  });

  it('masks the remainder of the file for an unterminated fence', () => {
    // Conservative direction: fewer findings, never a fabricated one.
    expect(mask('prose\n```\nstill open\nand still')).toEqual([false, true, true, true]);
  });

  it('masks a multi-line HTML comment', () => {
    expect(mask('a\n<!--\nhidden\n-->\nb')).toEqual([false, true, true, true, false]);
  });

  // A self-contained comment does NOT make the line non-prose: the prose
  // around it is still addressed to the reader. Masking the whole line lost
  // real findings on "NEVER run `x`. <!-- reviewed 2026-08 -->".
  it('leaves a line carrying only a self-contained comment as prose', () => {
    expect(mask('a\nrule text <!-- one liner -->\nb')).toEqual([false, false, false]);
  });

  // Regression: a context file may TALK about comment syntax. A naive
  // substring test opened a comment on this line and latched, masking every
  // remaining line and silently dropping findings for the rest of the file.
  it('does not latch on a <!-- mentioned inside an inline code span', () => {
    expect(mask('Use `<!--` to open a comment.\nNEVER run `x`.\nstill prose')).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('still latches on a genuine unclosed opener', () => {
    expect(mask('prose\n<!-- opened\nswallowed')).toEqual([false, true, true]);
  });

  it('does not let a <!-- inside a fence open a comment', () => {
    // 0: ```  1: <!--  2: ```  3: prose -- line 3 must stay prose.
    const m = mask('```\n<!--\n```\nprose');
    expect(m).toEqual([true, true, true, false]);
  });

  it('masks nothing in a file of pure prose', () => {
    expect(mask('one\ntwo\nthree')).toEqual([false, false, false]);
  });

  // A fence nested under a bullet is indented, and is masked only because
  // trimStart() runs before the ``` test. Indented fences are ubiquitous in
  // context files, so losing this silently restores the example-linted-as-rule
  // false positive the fence mask exists to prevent.
  it('masks a fence indented inside a list item', () => {
    expect(mask('- step one:\n  ```bash\n  npm ci\n  ```\n- step two')).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  // A closer with no opener is ordinary prose; it must not clear state it never
  // set, nor mask its own line.
  it('ignores a stray --> that never had an opener', () => {
    expect(mask('prose\nan arrow --> in prose\nmore prose')).toEqual([false, false, false]);
  });

  // Deleting the inner pair would splice `<!` and `-- y` into a `<!--` that
  // was never written and latch every following line as comment.
  it('does not synthesize an opener from a malformed nested comment', () => {
    expect(mask('<!<!-- x -->-- y\nNEVER run `x`.\nprose')).toEqual([false, false, false]);
  });

  it('still latches when an unclosed opener follows a complete pair', () => {
    expect(mask('a <!-- x --> b <!-- open\nswallowed\n-->\nprose')).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('stripInlineHtmlComments', () => {
  it('blanks complete pairs and preserves length', () => {
    const line = 'NEVER run `x`. <!-- reviewed -->';
    const out = stripInlineHtmlComments(line);
    expect(out).toHaveLength(line.length);
    expect(out.startsWith('NEVER run `x`. ')).toBe(true);
    expect(out).not.toContain('reviewed');
  });

  it('leaves a line with no comment untouched', () => {
    expect(stripInlineHtmlComments('plain prose')).toBe('plain prose');
  });

  it('blanks every complete pair on a line, not just the first', () => {
    const line = 'a <!-- x --> b <!-- y --> c';
    const out = stripInlineHtmlComments(line);
    expect(out).toHaveLength(line.length);
    expect(out).not.toContain('x');
    expect(out).not.toContain('y');
    // The prose between and around the comments survives.
    expect(out.replace(/#/g, '')).toBe('a  b  c');
  });

  // Load-bearing: an UNCLOSED opener must survive untouched, because that is
  // the token nonProseLineMask relies on to enter comment state for the
  // following lines. Blanking it here would strand a multi-line comment open.
  it('leaves an unclosed opener alone', () => {
    expect(stripInlineHtmlComments('a <!-- unclosed')).toBe('a <!-- unclosed');
  });

  it('blanks a malformed nested comment without leaving an opener behind', () => {
    const line = '<!<!-- x -->-- y --> tail';
    const out = stripInlineHtmlComments(line);
    expect(out).toHaveLength(line.length);
    expect(out).toBe('<!##########-- y --> tail');
    expect(out).not.toContain('<!--');
  });

  it('blanks overlapping-looking openers up to the first closer', () => {
    const line = '<!-- a <!-- b --> c -->';
    const out = stripInlineHtmlComments(line);
    expect(out).toHaveLength(line.length);
    expect(out).toBe('#'.repeat(17) + ' c -->');
  });
});

describe('classifyLines', () => {
  const classify = (md: string) => classifyLines(md.split('\n'));

  it('marks a fence written inside an HTML comment as comment, not fence', () => {
    // Reverse nesting: the comment opened first, so the fence is commentary.
    const out = classify('<!--\n```bash\nnpx old-tool\n```\n-->\nprose');
    expect(out.map((c) => c.comment)).toEqual([true, true, true, true, true, false]);
    expect(out.map((c) => c.fence)).toEqual([false, false, false, false, false, false]);
  });

  it('sees a --> inside a commented-out fence and closes the comment there', () => {
    const out = classify('<!--\n```\nold -->\nprose after\n```');
    expect(out.map((c) => c.comment)).toEqual([true, true, true, false, false]);
    // The trailing ``` is now a fence opener outside any comment.
    expect(out[4].fence).toBe(true);
  });

  it('still lets a fence opened outside a comment win over <!-- inside it', () => {
    const out = classify('```\n<!--\n```\nprose');
    expect(out.map((c) => c.fence)).toEqual([true, true, true, false]);
    expect(out.map((c) => c.comment)).toEqual([false, false, false, false]);
  });

  it('does not treat a one-line ```code``` snippet as a fence opener', () => {
    // A backtick fence's info string cannot contain backticks (CommonMark), so
    // this is an inline code span and must not flip state for the rest of the file.
    const out = classify('```echo hi```\nprose\nmore prose');
    expect(out.map((c) => c.fence)).toEqual([false, false, false]);
  });

  it('keeps a 4-backtick outer fence open across an inner ``` pair', () => {
    const out = classify('````md\n```bash\nx\n```\n````\nprose');
    expect(out.map((c) => c.fence)).toEqual([true, true, true, true, true, false]);
  });

  it('closes only on the same fence character, at least as long, with no info string', () => {
    const out = classify('~~~\n```\n~~\n~~~ info\n~~~~\nprose');
    expect(out.map((c) => c.fence)).toEqual([true, true, true, true, true, false]);
  });

  it('supports ~~~ fences', () => {
    const out = classify('~~~sh\nNEVER run x\n~~~\nprose');
    expect(out.map((c) => c.fence)).toEqual([true, true, true, false]);
  });
});

describe('htmlCommentLineMask', () => {
  const mask = (md: string) => htmlCommentLineMask(md.split('\n'));

  it('marks multi-line comment lines but leaves fenced code unmarked', () => {
    expect(mask('<!--\nnote\n-->\n```\nnpm test\n```')).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it('leaves a self-contained comment line unmarked', () => {
    expect(mask('Run `npm test`. <!-- reviewed -->')).toEqual([false]);
  });

  it('marks a command line inside a commented-out fence', () => {
    expect(mask('<!--\n```bash\nnpx old-tool\n```\n-->')).toEqual([true, true, true, true, true]);
  });
});

describe('htmlCommentSpans', () => {
  it('returns each complete comment range, markers included', () => {
    const line = 'a <!-- x --> b <!--y--> c';
    const spans = htmlCommentSpans(line);
    expect(spans.map((s) => line.slice(s.start, s.end))).toEqual(['<!-- x -->', '<!--y-->']);
  });

  it('returns nothing for an unclosed opener or plain prose', () => {
    expect(htmlCommentSpans('a <!-- open')).toEqual([]);
    expect(htmlCommentSpans('plain')).toEqual([]);
  });

  it('is independent of call order (no shared lastIndex)', () => {
    const line = 'x <!-- a --> y';
    expect(htmlCommentSpans(line)).toEqual(htmlCommentSpans(line));
    expect(htmlCommentSpans('<!--b-->')).toEqual([{ start: 0, end: 8 }]);
  });
});

describe('classifyLines CRLF', () => {
  it('recognises fences on CRLF lines', () => {
    const out = classifyLines('```bash\r\nnpm test\r\n```\r\nprose'.split('\n'));
    expect(out.map((c) => c.fence)).toEqual([true, true, true, false]);
  });
});

describe('classifyLines fence delimiters and info string', () => {
  it('marks opener and closer as delimiters and carries the info string on every fence line', () => {
    const out = classifyLines(['prose', '```Bash title=x ', 'npm test', '```', 'after']);
    expect(out.map((c) => c.fenceDelimiter)).toEqual([false, true, false, true, false]);
    expect(out.map((c) => c.fenceInfo)).toEqual([
      '',
      'Bash title=x',
      'Bash title=x',
      'Bash title=x',
      '',
    ]);
  });

  it('reports the info string after a longer or tilde opener', () => {
    const out = classifyLines(['````md', '```bash', '````', '~~~ sh', 'x', '~~~']);
    expect(out.map((c) => c.fenceInfo)).toEqual(['md', 'md', 'md', 'sh', 'sh', 'sh']);
    // The inner ``` line is content of the md fence, not a delimiter.
    expect(out.map((c) => c.fenceDelimiter)).toEqual([true, false, true, true, false, true]);
  });

  it('treats back-to-back fences as separate blocks', () => {
    const out = classifyLines(['```ts', '```', '```bash', '```']);
    expect(out.map((c) => c.fenceInfo)).toEqual(['ts', 'ts', 'bash', 'bash']);
    expect(out.every((c) => c.fenceDelimiter)).toBe(true);
  });
});

describe('isFrontmatterFence', () => {
  it('accepts --- with trailing whitespace or a CRLF carriage return', () => {
    expect(isFrontmatterFence('---')).toBe(true);
    expect(isFrontmatterFence('---  ')).toBe(true);
    expect(isFrontmatterFence('---\r')).toBe(true);
  });

  it('rejects an indented fence and other dash runs', () => {
    expect(isFrontmatterFence('  ---')).toBe(false);
    expect(isFrontmatterFence('--')).toBe(false);
    expect(isFrontmatterFence('----')).toBe(false);
    expect(isFrontmatterFence('--- x')).toBe(false);
  });
});
