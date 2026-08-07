import { readProjectTranscript } from '../../transcript.js';
import type { TranscriptEvent } from '../../transcript.js';
import type { LintIssue, SessionContext } from '../../types.js';

/**
 * Flag a session that asserts a quality gate PASSED while the gate's own
 * invocation failed or produced nothing.
 *
 * The motivating session ran `biome check` roughly a dozen times. On that host
 * (Windows ARM64) the binary segfaults during exit -- via the npx wrapper, via
 * the native `biome.exe`, and unchanged by shell -- producing ZERO bytes every
 * time. The agent twice reported this as "zero diagnostics emitted, which is
 * consistent with a clean run". That inference was wrong, and disproving it
 * took a deliberate experiment: the same binary against a file with an unused
 * variable and mangled formatting ALSO produced zero bytes. The crash precedes
 * diagnostic emission, so empty output carries no information about
 * cleanliness at all.
 *
 * The generalisable defect is an agent treating a failed or silent gate as
 * evidence of a passing one. In a session that signs off "typecheck clean,
 * tests pass, lint clean", the third clause was unsupported.
 *
 * Deliberately NOT flagged: prose that labels the state honestly. A session
 * saying "lint is UNVERIFIED because the runner crashed" reached the correct
 * conclusion and must stay clean. The rule targets the false CLAIM, not the
 * failed gate.
 *
 * Sibling rule: `commands/exit-status-masked` is the static half -- it reads a
 * documented command whose own shape discards the status (`... | tail -5 &&
 * echo clean`). This one is dynamic: it fires on a plain `pnpm lint` that
 * crashed, a command with nothing structurally wrong with it.
 */

/** Gate-shaped commands whose result the session is likely to sign off on. */
const GATE_PATTERNS: Array<{ re: RegExp; gate: string }> = [
  { re: /\b(biome|eslint|ruff|clippy)\b/, gate: 'lint' },
  { re: /\blint(:fix)?\b/, gate: 'lint' },
  { re: /\btsc\b|\btypecheck\b|\btype-check\b/, gate: 'typecheck' },
  { re: /\b(vitest|jest|pytest|mocha)\b/, gate: 'test' },
  { re: /\btest\b/, gate: 'test' },
  { re: /\bbuild\b/, gate: 'build' },
];

/** Prose asserting the gate passed. */
const CLEAN_CLAIMS = [
  /\ball green\b/i,
  /\bno (lint )?(violations|errors|issues|diagnostics)\b/i,
  /\b0 errors\b/i,
  /\bzero (errors|violations|diagnostics)\b/i,
  /\b(lint|typecheck|type-check|tests?|build)\b[^.\n]{0,40}\b(clean|passe[sd]|passing|green|succeeded)\b/i,
  /\b(clean|passing|green)\b[^.\n]{0,25}\b(lint|typecheck|type-check|tests?|build)\b/i,
];

/**
 * Prose that labels the gate honestly. Any of these near the claim means the
 * session did NOT overstate, so the finding is suppressed.
 */
const HONEST_MARKERS = [
  /\bunverified\b/i,
  /\bcould not verify\b/i,
  /\bcannot verify\b/i,
  /\bunable to verify\b/i,
  /\bcrashed?\b/i,
  /\bsegfault/i,
  /\bblocked\b/i,
  /\bnot trustworthy\b/i,
  /\bno signal\b/i,
  /\bdid not run\b/i,
  /\binconclusive\b/i,
];

/**
 * How many events after the failed gate still count as "adjacent". The claim
 * normally lands in the same turn or the next one; a match ten turns later is
 * probably about a different, later run of the same gate.
 */
const ADJACENCY = 12;

function gateOf(cmd: string): string | null {
  for (const { re, gate } of GATE_PATTERNS) {
    if (re.test(cmd)) return gate;
  }
  return null;
}

/** True when the invocation produced no usable pass/fail signal. */
function isUnverified(ev: TranscriptEvent): boolean {
  return ev.isError === true || ev.emptyOutput === true;
}

export async function checkUnverifiedGateClaimedClean(ctx: SessionContext): Promise<LintIssue[]> {
  const { events } = await readProjectTranscript(ctx.currentProject);
  if (events.length === 0) return [];

  const ordered = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const issues: LintIssue[] = [];
  const reported = new Set<string>();

  for (let i = 0; i < ordered.length; i++) {
    const ev = ordered[i];
    if (ev.kind !== 'command') continue;
    const gate = gateOf(ev.text);
    if (!gate || !isUnverified(ev)) continue;

    // Scan forward for a claim, stopping early if the same gate is re-run --
    // a later invocation supersedes this one, and if THAT run succeeded the
    // claim is about it and is honest.
    for (let j = i + 1; j < ordered.length && j <= i + ADJACENCY; j++) {
      const next = ordered[j];
      if (next.kind === 'command' && gateOf(next.text) === gate) break;
      if (next.kind !== 'assistant-text') continue;
      if (HONEST_MARKERS.some((re) => re.test(next.text))) break;
      if (!CLEAN_CLAIMS.some((re) => re.test(next.text))) continue;

      if (reported.has(gate)) break;
      reported.add(gate);
      const why = ev.isError ? 'the invocation reported an error' : 'the invocation produced no output';
      issues.push({
        severity: 'warning',
        check: 'session-unverified-gate-claimed-clean',
        ruleId: 'session-unverified-gate-claimed-clean/unverified-gate-claimed-clean',
        line: 0,
        message: `'${gate}' asserted as passing, but ${why}`,
        detail:
          `Gate command: ${ev.text.trim().slice(0, 120)}\n` +
          `Claim:        ${next.text.trim().slice(0, 120)}`,
        suggestion:
          'An empty or failed gate carries no information about cleanliness -- a runner ' +
          'that dies before emitting diagnostics looks exactly like one that found none. ' +
          'Either re-run the gate until it produces a real result, or report the state ' +
          'honestly ("lint UNVERIFIED -- runner crashed").',
      });
      break;
    }
  }

  return issues;
}
