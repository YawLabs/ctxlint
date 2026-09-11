import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { countTokens } from '../../../../utils/tokens.js';
import { encodeProjectDir } from '../../../session-parser.js';
import { clearTranscriptCache } from '../../../transcript.js';
import type { LintIssue } from '../../../types.js';
import { checkLargeRead, LARGE_READ_TOKENS } from '../large-read.js';

const PROJECT = '/repo/large-read';
const roots: string[] = [];
let seq = 0;

afterEach(() => {
  clearTranscriptCache();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function stamp(): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, ++seq)).toISOString();
}

/**
 * A run of ` x` that counts as exactly `n` tokens under whichever counter
 * `countTokens` is using (tiktoken, or the length/4 fallback). Found by
 * search rather than assumed, so the boundary tests below test the boundary
 * and not a guess about the tokenizer.
 */
function textOfTokens(n: number): string {
  let lo = 1;
  let hi = n * 8;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (countTokens(' x'.repeat(mid)) < n) lo = mid + 1;
    else hi = mid;
  }
  const text = ' x'.repeat(lo);
  if (countTokens(text) !== n) throw new Error(`no ' x' run counts as exactly ${n} tokens`);
  return text;
}

const BIG = textOfTokens(6000);

interface ReadOpts {
  input?: Record<string, unknown>;
  id?: string;
  msgId?: string;
  sessionId?: string;
  lines?: number;
  isError?: boolean;
}

/** A Read call and its result, as the two records Claude Code writes. */
function read(path: string, content: string, opts: ReadOpts = {}) {
  const id = opts.id ?? `r${++seq}`;
  const sessionId = opts.sessionId ?? 's1';
  const lines = opts.lines ?? 1;
  return [
    {
      type: 'assistant',
      timestamp: stamp(),
      sessionId,
      gitBranch: 'main',
      message: {
        id: opts.msgId ?? `m${++seq}`,
        content: [
          { type: 'tool_use', name: 'Read', id, input: { file_path: path, ...opts.input } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: stamp(),
      sessionId,
      message: {
        content: [
          { type: 'tool_result', tool_use_id: id, content, is_error: opts.isError ?? false },
        ],
      },
      toolUseResult: {
        type: 'text',
        file: { filePath: path, content: '', numLines: lines, startLine: 1, totalLines: lines },
      },
    },
  ];
}

/** One assistant turn, written as `parts` records sharing one message id. */
function turn(parts = 1, sessionId = 's1') {
  const msgId = `m${++seq}`;
  return Array.from({ length: parts }, () => ({
    type: 'assistant',
    timestamp: stamp(),
    sessionId,
    gitBranch: 'main',
    message: { id: msgId, content: [{ type: 'text', text: 'working' }] },
  }));
}

function compact(sessionId = 's1') {
  return { type: 'system', subtype: 'compact_boundary', timestamp: stamp(), sessionId };
}

/** Write each record list as its own transcript file, then run the check. */
async function run(files: unknown[][]): Promise<LintIssue[]> {
  const home = mkdtempSync(join(tmpdir(), 'ctxlint-large-read-'));
  roots.push(home);
  const dir = join(home, '.claude', 'projects', encodeProjectDir(PROJECT));
  mkdirSync(dir, { recursive: true });
  files.forEach((records, i) => {
    writeFileSync(
      join(dir, `s${i}.jsonl`),
      `${records.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
  });

  const prevHome = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  clearTranscriptCache();
  try {
    return await checkLargeRead({
      history: [],
      memories: [],
      siblings: [],
      currentProject: PROJECT,
      providers: ['claude-code'],
    });
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    clearTranscriptCache();
  }
}

describe('session/large-read', () => {
  it('summarizes a large whole-file Read in one info finding', async () => {
    // Read on turn 1 of 3: its result is re-sent on turns 2 and 3.
    const issues = await run([
      [...read(`${PROJECT}/src/big.ts`, BIG, { lines: 480 }), ...turn(), ...turn()],
    ]);
    expect(issues).toHaveLength(1);
    const [issue] = issues;
    expect(issue.severity).toBe('info');
    expect(issue.check).toBe('session-large-read');
    expect(issue.ruleId).toBe('session-large-read/large-read');
    expect(issue.message).toBe(
      '1 whole-file Read of 4,000+ tokens (6,000 tokens); ' +
        'est. 12,000 tokens of cache-read carry on later turns',
    );
    expect(issue.detail).toContain('src/big.ts -- 1 read, 6,000 tokens, 480 lines');
    expect(issue.detail).not.toContain('capped');
    expect(issue.suggestion).toContain('grep -n');
    expect(issue.suggestion).toContain('`offset`/`limit`');
    expect(issue.suggestion).toContain('subagent');
    // A baseline in tokens, not a bill: prices vary by model and change.
    for (const text of [issue.message, issue.detail, issue.suggestion]) {
      expect(text).not.toMatch(/\$|dollar|USD/i);
    }
  });

  it.each([
    ['offset', { offset: 1 }],
    ['limit', { limit: 2000 }],
    ['pages', { pages: '1-5' }],
  ])('does not count a partial Read (%s), however large', async (_label, input) => {
    const issues = await run([[...read(`${PROJECT}/src/big.ts`, BIG, { input }), ...turn()]]);
    expect(issues).toEqual([]);
  });

  it('does not count a whole-file Read under the threshold', async () => {
    const issues = await run([[...read(`${PROJECT}/src/small.ts`, textOfTokens(500)), ...turn()]]);
    expect(issues).toEqual([]);
  });

  it('counts a Read of exactly LARGE_READ_TOKENS', async () => {
    const issues = await run([
      [...read(`${PROJECT}/src/edge.ts`, textOfTokens(LARGE_READ_TOKENS)), ...turn()],
    ]);
    expect(issues).toHaveLength(1);
  });

  it('does not count a Read one token under LARGE_READ_TOKENS', async () => {
    const issues = await run([
      [...read(`${PROJECT}/src/edge.ts`, textOfTokens(LARGE_READ_TOKENS - 1)), ...turn()],
    ]);
    expect(issues).toEqual([]);
  });

  it('does not count a Read that errored', async () => {
    const issues = await run([
      [...read(`${PROJECT}/src/big.ts`, BIG, { isError: true }), ...turn()],
    ]);
    expect(issues).toEqual([]);
  });

  it('counts a response split across several records as one turn', async () => {
    // Two later turns, written as three records and two records. Counting
    // records would put five turns after the Read and report 30,000.
    const issues = await run([[...read(`${PROJECT}/src/big.ts`, BIG), ...turn(3), ...turn(2)]]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('est. 12,000 tokens of cache-read carry');
  });

  it('stops the carry at the next /compact boundary', async () => {
    // One turn re-sends the result before the compaction drops it; the three
    // turns after it do not.
    const issues = await run([
      [
        ...read(`${PROJECT}/src/big.ts`, BIG),
        ...turn(),
        compact(),
        ...turn(),
        ...turn(),
        ...turn(),
      ],
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('est. 6,000 tokens of cache-read carry');
  });

  it('counts a Read copied into a continued session once, with the smaller carry', async () => {
    const copied = { id: 'r-copied', msgId: 'm-copied' };
    const issues = await run([
      [...read(`${PROJECT}/src/big.ts`, BIG, { ...copied, sessionId: 'old' }), ...turn(1, 'old')],
      [
        ...read(`${PROJECT}/src/big.ts`, BIG, { ...copied, sessionId: 'new' }),
        ...turn(1, 'new'),
        ...turn(1, 'new'),
        ...turn(1, 'new'),
      ],
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toBe(
      '1 whole-file Read of 4,000+ tokens (6,000 tokens); ' +
        'est. 6,000 tokens of cache-read carry on later turns',
    );
  });

  it('lists the top three files by tokens, with read counts', async () => {
    const issues = await run([
      [
        ...read(`${PROJECT}/src/a.ts`, BIG),
        ...read(`${PROJECT}/src/a.ts`, BIG),
        ...read(`${PROJECT}/src/b.ts`, textOfTokens(5000)),
        ...read(`${PROJECT}/src/c.ts`, textOfTokens(4500)),
        ...read(`${PROJECT}/src/d.ts`, textOfTokens(4200)),
      ],
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/^5 whole-file Reads of 4,000\+ tokens \(25,700 tokens\)/);
    const detail = issues[0].detail ?? '';
    expect(detail).toContain('src/a.ts -- 2 reads, 12,000 tokens');
    expect(detail).toContain('src/b.ts -- 1 read, 5,000 tokens');
    expect(detail).toContain('src/c.ts -- 1 read, 4,500 tokens');
    expect(detail).not.toContain('src/d.ts');
    expect(detail.indexOf('src/a.ts')).toBeLessThan(detail.indexOf('src/b.ts'));
    expect(detail.indexOf('src/b.ts')).toBeLessThan(detail.indexOf('src/c.ts'));
  });

  it('says so when the transcript read was capped', async () => {
    // More transcripts than the reader reads. Every one carries a large Read,
    // so there is a finding whichever five are chosen.
    const issues = await run(
      Array.from({ length: 6 }, (_, i) => [...read(`${PROJECT}/src/f${i}.ts`, BIG), ...turn()]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].detail).toContain('capped');
  });

  it('emits nothing for a project with no transcripts', async () => {
    expect(await run([])).toEqual([]);
  });
});
