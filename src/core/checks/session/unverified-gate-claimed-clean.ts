import { readProjectTranscript, truncationNote } from '../../transcript.js';
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
 * Deliberately NOT flagged:
 *   - Prose that labels the state honestly. A session saying "lint is
 *     UNVERIFIED because the runner crashed" reached the correct conclusion.
 *     The rule targets the false CLAIM, not the failed gate.
 *   - Empty output from a tool that is silent on success (`tsc`, `eslint`).
 *     Nothing printed is what those tools print when they pass, so emptiness
 *     alone says nothing; they count only when the result is an error or
 *     carries a crash signature.
 *   - A claim about a different gate ("the build passes" after a failed test
 *     run), a negated one ("tests are still not passing"), or stated intent
 *     ("I will make the tests green next").
 *   - A claim in a different session from the failed gate.
 *
 * Sibling rule: `commands/exit-status-masked` is the static half -- it reads a
 * documented command whose own shape discards the status (`... | tail -5 &&
 * echo clean`). This one is dynamic: it fires on a plain `pnpm lint` that
 * crashed, a command with nothing structurally wrong with it.
 */

type Gate = 'lint' | 'typecheck' | 'test' | 'build';

/** Tools invoked directly, by program name. */
const TOOL_GATES: Record<string, Gate> = {
  biome: 'lint',
  eslint: 'lint',
  ruff: 'lint',
  tsc: 'typecheck',
  'vue-tsc': 'typecheck',
  mypy: 'typecheck',
  pyright: 'typecheck',
  vitest: 'test',
  jest: 'test',
  pytest: 'test',
  mocha: 'test',
};

/**
 * Tools that print NOTHING when they pass. For these an empty result is the
 * success shape, so it is not evidence of a crash.
 */
const SILENT_ON_SUCCESS = new Set(['eslint', 'tsc', 'vue-tsc']);

/** Output that means the runner died rather than reported. */
const CRASH_SIGNATURES = [
  /\bsegmentation fault\b/i,
  /\bsegfault/i,
  /\bSIGSEGV\b/,
  /\b3221225477\b/, // 0xC0000005, STATUS_ACCESS_VIOLATION on Windows
  /\b0xC0000005\b/i,
  /\bFATAL ERROR:/, // V8 / node fatal error (heap OOM and friends)
  /\bnode:? fatal error\b/i,
  /\bcore dumped\b/i,
];

/** Script names (npm/pnpm/yarn/bun run X, make X) that are gates. */
function scriptGate(name: string): Gate | null {
  const base = name.toLowerCase();
  if (/^lint(:|$)/.test(base)) return 'lint';
  if (/^(typecheck|type-check|tsc|types|check-types)(:|$)/.test(base)) return 'typecheck';
  if (/^test(s)?(:|$)/.test(base)) return 'test';
  if (/^build(:|$)/.test(base)) return 'build';
  return null;
}

/** Wrappers whose next word is the real program. */
const WRAPPERS = new Set(['npx', 'bunx', 'time', 'sudo', 'env', 'exec', 'command']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
/** Package-manager flags that take a value (`pnpm -C dir test`). */
const PM_VALUE_FLAGS = new Set(['-C', '--dir', '--prefix', '--filter', '-F', '-w', '--workspace']);

interface Invocation {
  gate: Gate;
  /** The program name that ran, for the silent-on-success decision. */
  program: string;
}

/**
 * The gates a command invokes. A gate is the PROGRAM a command segment runs
 * (after env assignments and wrappers like `npx`), or a package-manager /
 * `make` script, or a cargo/go subcommand -- never a word that merely appears
 * in an argument (`rm -rf build`, `git add src/foo.test.ts`).
 */
function gatesOf(cmd: string): Invocation[] {
  const found: Invocation[] = [];
  for (const segment of cmd.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    while (i < words.length && WRAPPERS.has(words[i])) i++;
    if (i >= words.length) continue;
    // `./node_modules/.bin/eslint`, `C:\...\tsc.cmd` -> the bare program name.
    const program = (words[i].split(/[\\/]/).pop() ?? '')
      .replace(/\.(cmd|exe|ps1|js|mjs)$/i, '')
      .toLowerCase();
    const rest = words.slice(i + 1);
    const push = (gate: Gate | null) => {
      if (gate) found.push({ gate, program });
    };

    if (TOOL_GATES[program]) {
      push(TOOL_GATES[program]);
      continue;
    }
    if (PACKAGE_MANAGERS.has(program)) {
      // `pnpm exec eslint`, `pnpm dlx vitest`, `yarn dlx ...`: the next word is
      // the real program.
      let j = 0;
      while (j < rest.length && rest[j].startsWith('-')) j += PM_VALUE_FLAGS.has(rest[j]) ? 2 : 1;
      let sub = rest[j];
      if (sub === 'run' || sub === 'run-script') sub = rest[j + 1];
      else if (sub === 'exec' || sub === 'dlx' || sub === 'x') {
        const tool = (rest[j + 1] ?? '').toLowerCase();
        if (TOOL_GATES[tool]) found.push({ gate: TOOL_GATES[tool], program: tool });
        continue;
      }
      if (sub) push(scriptGate(sub));
      continue;
    }
    if (program === 'make') {
      for (const target of rest.filter((w) => !w.startsWith('-'))) push(scriptGate(target));
      continue;
    }
    if (program === 'cargo') {
      const sub = rest.find((w) => !w.startsWith('-') && !w.startsWith('+'));
      if (sub === 'clippy') push('lint');
      else if (sub === 'test') push('test');
      else if (sub === 'build') push('build');
      else if (sub === 'check') push('typecheck');
      continue;
    }
    if (program === 'go') {
      const sub = rest[0];
      if (sub === 'vet') push('lint');
      else if (sub === 'test') push('test');
      else if (sub === 'build') push('build');
    }
  }
  // One entry per gate: `pnpm lint && pnpm lint:fix` is one lint run.
  return found.filter((g, idx) => found.findIndex((o) => o.gate === g.gate) === idx);
}

/** Nouns that name each gate in prose. */
const GATE_NOUNS: Record<Gate, string> = {
  lint: 'lint(?:ing|er)?|biome|eslint|ruff|clippy',
  typecheck: 'type-?check(?:ing)?|type check|types|tsc',
  test: 'tests?|test suite|vitest|jest|pytest|specs?',
  build: 'builds?',
};

const PASS_WORDS =
  'clean|pass(?:es|ed|ing)?|green|succeed(?:s|ed)?|succeeded|ok|fine|good|no (?:errors|issues|failures)';

/** Generic all-gates claims that name no gate. */
const GENERIC_CLAIMS = [
  /\ball (?:green|gates? pass(?:ed|es)?|checks? pass(?:ed|es)?|clean)\b/i,
  /\bno (?:violations|errors|issues|diagnostics)\b/i,
  /\b0 errors\b/i,
  /\bzero (?:errors|violations|diagnostics)\b/i,
];

/** A negation inside the claim span, or just before the gate noun. */
const NEGATION =
  /\b(?:not|never|no longer|isn't|aren't|wasn't|weren't|doesn't|don't|didn't|won't|can't|cannot|fail(?:s|ed|ing)?|broken|red)\b/i;
const NEGATED_PREFIX = /\b(?:not|no|none of the|never)\s+(?:all\s+)?(?:the\s+)?$/i;
/**
 * Stated intent or a condition, not a report. A bare `make` counts only in
 * verb position ("make the tests pass", "make tests green"): "`make lint` is
 * clean" names a make target, which gatesOf reads as the lint gate.
 */
const INTENT =
  /\b(?:will|'ll|going to|gonna|need(?:s)? to|should|let me|let's|try(?:ing)? to|to make|(?<![`'"])make\s+(?:sure|the|it|them|this|that|these|those|all|every\w*|our|my|your|\w+\s+(?:pass|green|clean|succeed|work))|until|once|if|so that|want to|plan to|next)\b/i;

/** Every gate noun across all gates, to tell whether a clause names any gate. */
const ANY_GATE = new RegExp(`\\b(?:${Object.values(GATE_NOUNS).join('|')})\\b`, 'i');

/**
 * Split prose into clauses. A claim and its negation must sit in the same
 * clause, and "X failed; Y passes though" is two claims about two gates.
 */
function clauses(text: string): string[] {
  return text
    .split(
      /[.!?;:\n]+|\s[-\u2013\u2014]+\s|,?\s+\b(?:but|though|although|however|whereas|while)\b/i,
    )
    .map((c) => c.trim())
    .filter(Boolean);
}

/** True when `text` asserts that `gate` passed. */
function claimsPass(text: string, gate: Gate): boolean {
  const noun = GATE_NOUNS[gate];
  const nounFirst = new RegExp(`\\b(?:${noun})\\b[^.\\n]{0,40}?\\b(?:${PASS_WORDS})\\b`, 'gi');
  const passFirst = new RegExp(`\\b(?:clean|passing|green)\\s+(?:${noun})\\b`, 'gi');
  for (const clause of clauses(text)) {
    for (const re of [nounFirst, passFirst]) {
      for (const m of clause.matchAll(re)) {
        const before = clause.slice(0, m.index);
        if (NEGATION.test(m[0]) || NEGATED_PREFIX.test(before)) continue;
        // Tested on the clause up to the end of the match, so an intent that
        // spans into it ("make tests pass") is seen.
        if (INTENT.test(clause.slice(0, m.index + m[0].length))) continue;
        return true;
      }
    }
    // A generic "all green" / "no errors" counts for this gate when the clause
    // names this gate or no gate at all.
    if (GENERIC_CLAIMS.some((re) => re.test(clause))) {
      const namesThis = new RegExp(`\\b(?:${noun})\\b`, 'i').test(clause);
      if ((namesThis || !ANY_GATE.test(clause)) && !INTENT.test(clause)) {
        const negated = clause.replace(/\bno (?:violations|errors|issues|diagnostics)\b/gi, '');
        if (!NEGATION.test(negated)) return true;
      }
    }
  }
  return false;
}

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

/**
 * Why an invocation produced no usable pass/fail signal, or null when it did.
 * A crash banner at either end of the output (`outputExcerpt`) wins; then the
 * harness error flag; then emptiness, except for tools that print nothing
 * when they pass.
 */
function unverifiedReason(ev: TranscriptEvent, inv: Invocation): string | null {
  const out = ev.outputExcerpt ?? '';
  if (CRASH_SIGNATURES.some((re) => re.test(out))) return 'the invocation crashed';
  if (ev.isError === true) return 'the invocation reported an error';
  if (ev.emptyOutput === true && !SILENT_ON_SUCCESS.has(inv.program)) {
    return 'the invocation produced no output';
  }
  return null;
}

export async function checkUnverifiedGateClaimedClean(ctx: SessionContext): Promise<LintIssue[]> {
  const read = await readProjectTranscript(ctx.currentProject);
  if (read.events.length === 0) return [];

  // Walk each session on its own: a failed gate in one session and a claim in
  // another (concurrent, or days later) are unrelated. Reads are left out of
  // the walk: ADJACENCY counts events, so a burst of Reads between a failed
  // gate and the claim about it would push a genuine claim out of the window.
  const bySession = new Map<string, TranscriptEvent[]>();
  for (const e of read.events) {
    if (e.kind === 'file-read') continue;
    const list = bySession.get(e.sessionId);
    if (list) list.push(e);
    else bySession.set(e.sessionId, [e]);
  }

  const issues: LintIssue[] = [];
  const reported = new Set<Gate>();
  const note = truncationNote(read);

  for (const events of bySession.values()) {
    const ordered = events.sort((a, b) => a.timestamp - b.timestamp);
    for (let i = 0; i < ordered.length; i++) {
      const ev = ordered[i];
      if (ev.kind !== 'command') continue;
      for (const inv of gatesOf(ev.text)) {
        if (reported.has(inv.gate)) continue;
        const why = unverifiedReason(ev, inv);
        if (!why) continue;

        // Scan forward for a claim, stopping early if the same gate is re-run
        // -- a later invocation supersedes this one, and if THAT run succeeded
        // the claim is about it and is honest.
        for (let j = i + 1; j < ordered.length && j <= i + ADJACENCY; j++) {
          const next = ordered[j];
          if (next.kind === 'command' && gatesOf(next.text).some((g) => g.gate === inv.gate)) break;
          if (next.kind !== 'assistant-text') continue;
          if (HONEST_MARKERS.some((re) => re.test(next.text))) break;
          if (!claimsPass(next.text, inv.gate)) continue;

          reported.add(inv.gate);
          issues.push({
            severity: 'warning',
            check: 'session-unverified-gate-claimed-clean',
            ruleId: 'session-unverified-gate-claimed-clean/unverified-gate-claimed-clean',
            line: 0,
            message: `'${inv.gate}' asserted as passing, but ${why}`,
            detail:
              `Gate command: ${ev.text.trim().slice(0, 120)}\n` +
              `Claim:        ${next.text.trim().slice(0, 120)}` +
              (note ? `\n${note}` : ''),
            suggestion:
              'An empty or failed gate carries no information about cleanliness -- a runner ' +
              'that dies before emitting diagnostics looks exactly like one that found none. ' +
              'Either re-run the gate until it produces a real result, or report the state ' +
              'honestly ("lint UNVERIFIED -- runner crashed").',
          });
          break;
        }
      }
    }
  }

  return issues;
}
