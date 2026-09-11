import { isAbsolute, relative } from 'node:path';
import { readProjectTranscript, turnsCarried } from '../../transcript.js';
import type { TranscriptEvent } from '../../transcript.js';
import type { LintIssue, SessionContext } from '../../types.js';

/**
 * Baseline how much session context goes to whole-file Reads of large files.
 *
 * A Read's result enters the transcript as a tool_result and stays in the
 * prompt of every later turn of the session. With prompt caching those
 * re-sends bill as cache reads: cheap per token, but paid once per turn for as
 * long as the session runs. A 900-line file read whole on turn 10 of a
 * 200-turn session is re-sent 190 times, when `grep -n` plus a Read with
 * `offset`/`limit` would have carried only the lines the question needed.
 *
 * This is a MEASUREMENT, reported as one info-level summary per project. It
 * gives a user the size of that cost before they adopt any read-routing, so
 * the change has a baseline to be judged against. No single whole-file Read is
 * a defect -- reading a file whole is often right -- which is why there is one
 * summary rather than a finding per read, and why it never fails CI.
 *
 * Deliberately NOT counted:
 *   - Partial Reads (`offset`, `limit` or `pages` set). Those are the fix.
 *   - Reads that errored. An error result is not the file.
 *   - Results under the threshold. A small file read whole costs little.
 */

/**
 * A whole-file Read whose result reaches this many tokens counts. Across 202
 * real whole-file Reads, Read output (line-number prefixes included) ran at a
 * median 12.5 tokens per line, interquartile 11.2-15.9, which puts this at
 * roughly 320 lines, 250-360 across that range.
 */
export const LARGE_READ_TOKENS = 4000;

/** Files listed in the summary's detail. */
const TOP_FILES = 3;

interface Qualifying {
  ev: TranscriptEvent;
  tokens: number;
  /** Later turns of the session that re-sent this result. */
  carried: number;
}

/** True when a Read event is a whole-file read big enough to count. */
function qualifies(ev: TranscriptEvent): boolean {
  if (ev.kind !== 'file-read' || ev.partial || ev.isError) return false;
  return (ev.outputTokens ?? 0) >= LARGE_READ_TOKENS;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** The path relative to the project when it lies inside it, else as recorded. */
function displayPath(path: string, project: string): string {
  const rel = relative(project, path);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return rel.replace(/\\/g, '/');
  return path;
}

/**
 * Grouping key for "the same file". The harness records the path as the agent
 * spelled it, so separators vary; Windows paths are case-insensitive too.
 */
function fileKey(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

export async function checkLargeRead(ctx: SessionContext): Promise<LintIssue[]> {
  const read = await readProjectTranscript(ctx.currentProject);

  // One physical Read is counted once. A continued session copies the tail of
  // the previous one into its own file under a new session id, so the same
  // tool_use can appear twice. The copy is re-sent in the new session as well,
  // so the true carry is the sum of both; the smaller is kept, which keeps the
  // estimate a floor rather than an overstatement.
  const byCall = new Map<string, Qualifying>();
  const unkeyed: Qualifying[] = [];
  for (const ev of read.events) {
    if (!qualifies(ev)) continue;
    const hit = { ev, tokens: ev.outputTokens ?? 0, carried: turnsCarried(read, ev) };
    if (!ev.toolUseId) {
      unkeyed.push(hit);
      continue;
    }
    const prev = byCall.get(ev.toolUseId);
    if (!prev || hit.carried < prev.carried) byCall.set(ev.toolUseId, hit);
  }
  const hits = [...byCall.values(), ...unkeyed];
  if (hits.length === 0) return [];

  let totalTokens = 0;
  let carry = 0;
  const files = new Map<string, { path: string; reads: number; tokens: number; lines?: number }>();
  for (const { ev, tokens, carried } of hits) {
    totalTokens += tokens;
    carry += tokens * carried;
    const key = fileKey(ev.text);
    const file = files.get(key) ?? { path: ev.text, reads: 0, tokens: 0 };
    file.reads += 1;
    file.tokens += tokens;
    if (ev.outputLines !== undefined) file.lines = Math.max(file.lines ?? 0, ev.outputLines);
    files.set(key, file);
  }

  const top = [...files.values()]
    .sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path))
    .slice(0, TOP_FILES);
  const topLines = top.map((f) => {
    const reads = `${f.reads} read${f.reads === 1 ? '' : 's'}`;
    const lines = f.lines !== undefined ? `, ${fmt(f.lines)} line${f.lines === 1 ? '' : 's'}` : '';
    return `  ${displayPath(f.path, ctx.currentProject)} -- ${reads}, ${fmt(f.tokens)} tokens${lines}`;
  });

  const count = hits.length;
  const detail = [
    `Largest files by tokens read whole:`,
    ...topLines,
    `Carry = each Read's result tokens x the later turns of its session that re-sent it ` +
      `(to the session's end or its next /compact). An estimate: tokens are counted with a ` +
      `proxy tokenizer, and a result's first re-send is a cache write rather than a read.`,
  ];
  if (read.truncated) {
    detail.push(
      `Transcript read was capped (${read.filesRead} most recent transcripts, bounded line count): ` +
        `these figures cover only what was read, so the real totals are higher.`,
    );
  }

  return [
    {
      severity: 'info',
      check: 'session-large-read',
      ruleId: 'session-large-read/large-read',
      line: 0,
      message:
        `${count} whole-file Read${count === 1 ? '' : 's'} of ${fmt(LARGE_READ_TOKENS)}+ tokens ` +
        `(${fmt(totalTokens)} tokens); est. ${fmt(carry)} tokens of cache-read carry on later turns`,
      detail: detail.join('\n'),
      suggestion:
        'Before reading a large file whole, find the part you need with `grep -n` (or the Grep ' +
        'tool) and Read just that range with `offset`/`limit`. For a question that needs the ' +
        'whole file, delegate it to a subagent: its reads stay in its own context and only the ' +
        'answer comes back.',
    },
  ];
}
