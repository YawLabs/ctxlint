import { describe, it, expect } from 'vitest';
import {
  inlineCodeSpans,
  maskCodeSpans,
  nonProseLineMask,
  stripInlineHtmlComments,
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
});
