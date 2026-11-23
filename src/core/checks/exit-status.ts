/**
 * Static analysis behind `commands/exit-status-masked`.
 *
 * A shell pipeline's exit status is the LAST command's. So
 * `npx tsc --noEmit | head -20 && echo "tsc clean"` reports `head`'s success:
 * the `&&` fires and prints `tsc clean` over a real type error. The same
 * discard happens with `npx biome check src/ 2>&1 | tail -5; echo "exit=$?"` --
 * that `$?` is `tail`'s status, not biome's.
 *
 * Both shapes convert "prove it works" into "print that it works", and both
 * were produced live in the sessions that motivated this rule. Context files
 * and skills are full of copy-paste verification snippets, so the shape
 * propagates.
 *
 * Sibling rule: `session/unverified-gate-claimed-clean` is the DYNAMIC half --
 * it reads a transcript where a structurally-fine gate crashed and the session
 * signed off on it anyway. This one is static: the command's own shape
 * guarantees the claim cannot fail.
 *
 * Everything here is a pure function of the command string (plus the file's
 * text for `pipefail` scoping), so the false-positive boundary is unit
 * testable without a fixture project.
 */

import { htmlCommentLineMask, nonProseLineMask } from '../../utils/markdown.js';

/**
 * Commands whose EXIT STATUS is the reason to run them. Deliberately narrow:
 * a general command piped into a pager is normal shell usage and must stay
 * silent. Only a verification tool's discarded status is a defect.
 *
 * The name must end at whitespace or end of string, so `tsc-watch` (a watcher,
 * not a gate) is not read as `tsc`.
 *
 * How to refresh: add a tool here only when its documented contract is "exit
 * non-zero on a finding" (type checkers, linters in check mode, test runners).
 * A tool that only does so behind a flag belongs in VERIFIER_PAIRS with that
 * flag, the way `prettier --check` is.
 */
const VERIFIER_PATTERN =
  /^(tsc|vue-tsc|svelte-check|eslint|biome|oxlint|stylelint|vitest|jest|mocha|ava|pytest|mypy|pyright|ruff|flake8)(?=\s|$)/;

/**
 * Multi-token verifiers, matched before the single-token set. `m[0]` is the
 * name reported in the message, so a pattern that needs to look at a later
 * flag does it in a lookahead.
 *
 * How to refresh: one entry per (tool, gating subcommand). Keep each language's
 * build/test/lint verbs aligned -- `go build` was listed while `cargo build`
 * was not, which is the drift this comment exists to stop.
 */
const VERIFIER_PAIRS = [
  /^cargo\s+(test|clippy|check|build)(?=\s|$)/,
  /^go\s+(test|vet|build)(?=\s|$)/,
  /^deno\s+(test|check|lint)(?=\s|$)/,
  /^bun\s+test(?=\s|$)/,
  /^playwright\s+test(?=\s|$)/,
  /^python3?\s+-m\s+(pytest|mypy|unittest)(?=\s|$)/,
  /^prettier(?=\s(?:.*\s)?(?:--check|-c|--list-different|-l)(?:\s|$))/,
];

/**
 * Filters and pagers. A pipeline ending in one of these reports ITS status,
 * which is ~always 0 -- that is the whole masking mechanism.
 *
 * `grep` earns its place even though `... | grep -q x && echo found` is a
 * deliberate gate: piping a VERIFIER into grep and then announcing success
 * inverts the meaning (grep exits 0 when it FINDS something, so
 * `tsc | grep error && echo clean` prints "clean" precisely when there are
 * errors). Both readings are defects.
 *
 * How to refresh: a command belongs here when it exits 0 for ordinary input
 * regardless of what the upstream verifier printed. Search tools (`rg`) are
 * here for the same reason as `grep`.
 */
const FILTER_PATTERN =
  /^(head|tail|grep|egrep|fgrep|rg|sed|awk|less|more|cat|tee|wc|sort|uniq|cut|tr)(?=\s|$)/;

/**
 * Package-manager script runners, for resolving `npm run lint` to its body.
 * pnpm/yarn/bun also accept a bare `<runner> <name>`; when `<name>` is not a
 * script they run the local binary of that name instead (`pnpm tsc`), which
 * verifierName handles by classifying the remainder as a direct command.
 */
const SCRIPT_RUNNER = /^(?:npm\s+run(?:-script)?|(?:pnpm|yarn|bun)(?:\s+run)?)\s+(\S+)/;
/** The runner prefix alone, for falling through to the direct command. */
const BARE_RUNNER_PREFIX = /^(?:pnpm|yarn|bun)(?:\s+run)?\s+/;

/**
 * npm's lifecycle commands, mapped to the script each one runs. npm, unlike
 * pnpm/yarn/bun, does NOT run an arbitrary `npm <script>` -- only these map to
 * a script, and the `t`/`tst` aliases run `test`. Shared with commands.ts so
 * the two rules agree on what `npm <word>` runs.
 *
 * How to refresh: this is npm's own list (`npm help run-script` /
 * `npm help test`). It changes only when npm adds a lifecycle shorthand.
 */
export const NPM_LIFECYCLE_SHORTHANDS: Readonly<Record<string, string>> = {
  test: 'test',
  t: 'test',
  tst: 'test',
  start: 'start',
  stop: 'stop',
  restart: 'restart',
};

/**
 * `npm <lifecycle>`, matched separately from SCRIPT_RUNNER so a bare
 * `npm install` never gets looked up as a script. The lookahead keeps
 * `npm test-unit` from reading as `npm test`.
 */
const SCRIPT_SHORTHAND = new RegExp(
  `^npm\\s+(${Object.keys(NPM_LIFECYCLE_SHORTHANDS).join('|')})(?=\\s|$)`,
);

/**
 * Wrappers that delegate to another command, keyed by name, with the flags of
 * each that consume a separate value (`npx -p pkg`, `nice -n 10`, `sudo -u u`).
 * Shared with cli-subcommands.ts so the two command scanners agree on what a
 * wrapper is -- the tables had already drifted (`command`/`nice` here only).
 *
 * How to refresh: add a wrapper only when its contract is "run argv[1..] as a
 * command". A flag that changes that (`command -v` looks a name up instead of
 * running it) is handled in stripWrapperTokens.
 */
export const WRAPPERS: Readonly<Record<string, readonly string[]>> = {
  npx: ['-p', '--package'],
  bunx: ['-p', '--package'],
  sudo: ['-u', '-g', '-h', '-C'],
  time: ['-f', '-o'],
  command: [],
  nice: ['-n'],
};

/** Wrappers that run a PACKAGE's bin, so the next token may be `pkg@version`. */
const PACKAGE_WRAPPERS = new Set(['npx', 'bunx']);

/** Two-token wrappers: `pnpm exec`, `npm exec`, `yarn dlx`, `pnpm dlx`, `bun x`. */
export const EXEC_WRAPPER_PATTERN = /^(?:(?:pnpm|npm|yarn|bun)\s+(?:exec|dlx)|bun\s+x)(?=\s|$)/;

/**
 * Strip leading wrapper tokens (and each wrapper's flags) from an argv-style
 * token list. `packageRunner` is true when one of the stripped wrappers runs a
 * package bin (`npx`, `bunx`, `pnpm dlx`, `npm exec`, `bun x`), i.e. when the
 * first remaining token may be a `pkg@version` spec rather than a command.
 */
export function stripWrapperTokens(tokens: string[]): { rest: string[]; packageRunner: boolean } {
  let rest = tokens;
  let packageRunner = false;
  for (;;) {
    if (rest.length >= 2 && EXEC_WRAPPER_PATTERN.test(`${rest[0]} ${rest[1]}`)) {
      rest = rest.slice(2);
      packageRunner = true;
      while (rest.length > 0 && rest[0].startsWith('-')) rest = rest.slice(1);
      continue;
    }
    const head = rest[0];
    if (head === undefined || !Object.hasOwn(WRAPPERS, head)) break;
    // `command -v x` / `command -V x` look `x` up; they do not run it.
    if (head === 'command' && (rest[1] === '-v' || rest[1] === '-V')) break;
    const valueFlags = WRAPPERS[head];
    let i = 1;
    while (i < rest.length && rest[i].startsWith('-')) {
      if (!rest[i].includes('=') && valueFlags.includes(rest[i])) i++;
      i++;
    }
    if (i >= rest.length) break; // a wrapper with nothing to wrap
    if (PACKAGE_WRAPPERS.has(head)) packageRunner = true;
    rest = rest.slice(i);
  }
  return { rest, packageRunner };
}

/**
 * Words an `echo`/`printf` uses to ANNOUNCE success. The claim has to assert
 * a passing state -- `echo "has errors"` after a grep is honest reporting and
 * stays silent.
 */
const SUCCESS_WORD =
  /\b(ok|okay|clean|pass|passed|passes|passing|green|success|successful|done|all\s+good|no\s+errors|looks\s+good)\b/i;

/**
 * A negation or failure word BEFORE the success word turns the echo into a
 * failure report: `grep -q "error TS" && echo "FAIL: not clean"` is a correct
 * gate (grep found an error, so say so), not a false success claim.
 *
 * A zero COUNT is not a negation: "0 errors, clean" and "no issues - passed"
 * are the commonest false success claims of all, so ZERO_COUNT is blanked out
 * of the text before NEGATION_BEFORE looks at it.
 */
const NEGATION_BEFORE = /\b(not|never|no|fail|failed|fails|failure|error|errors|isn'?t|aren'?t)\b/i;

/** "0 errors", "no issues", "zero failures", "0 failed", "errors: 0". */
const ZERO_COUNT =
  /\b(?:0|no|zero)\s+(?:errors?|issues?|problems?|warnings?|failures?|failed|failing)\b|\b(?:errors?|issues?|problems?|warnings?|failures?|failed):?\s*0\b/gi;

/** `set -o pipefail` in any of its spellings (`-eo`, `-euo`, `-o`). */
const PIPEFAIL = /\bset\s+[-\w\s]*\bpipefail\b/;

export type MaskedKind = 'success-claim' | 'status-echo';

export interface MaskedExitStatus {
  /** The command whose status is discarded, e.g. `tsc`. */
  verifier: string;
  /** The filter whose status the pipeline actually reports, e.g. `head`. */
  filter: string;
  /** The trailing command that consumes the (wrong) status. */
  claim: string;
  kind: MaskedKind;
}

interface Segment {
  /** Operator that PRECEDED this segment (`''` for the first). */
  op: '' | '&&' | '||' | ';';
  text: string;
}

/**
 * Split a command line on top-level `&&` / `||` / `;`, ignoring operators
 * inside single quotes, double quotes, or escaped by a backslash. Returns each
 * segment with the operator that introduced it.
 */
export function splitSegments(cmd: string): Segment[] {
  const out: Segment[] = [];
  let buf = '';
  let op: Segment['op'] = '';
  let quote: '"' | "'" | '`' | null = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && quote !== "'") {
        // Escaped char inside a double/backtick quote -- consume the next byte
        // verbatim so `\"` doesn't close the quote.
        if (i + 1 < cmd.length) buf += cmd[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < cmd.length) {
      buf += ch + cmd[++i];
      continue;
    }
    if (ch === '&' && cmd[i + 1] === '&') {
      out.push({ op, text: buf.trim() });
      op = '&&';
      buf = '';
      i++;
      continue;
    }
    if (ch === '|' && cmd[i + 1] === '|') {
      out.push({ op, text: buf.trim() });
      op = '||';
      buf = '';
      i++;
      continue;
    }
    if (ch === ';') {
      out.push({ op, text: buf.trim() });
      op = ';';
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push({ op, text: buf.trim() });
  return out.filter((s) => s.text.length > 0);
}

/**
 * Split ONE segment on top-level single `|`, quote-aware. `||` never reaches
 * here (splitSegments consumed it), so any `|` outside quotes is a pipe.
 */
export function splitPipes(segment: string): string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | '`' | null = null;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      buf += ch;
      if (ch === '\\' && quote !== "'") {
        if (i + 1 < segment.length) buf += segment[++i];
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch === '\\' && i + 1 < segment.length) {
      buf += ch + segment[++i];
      continue;
    }
    if (ch === '|') {
      out.push(buf.trim());
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf.trim());
  return out.map((s) => s.trim());
}

/**
 * Strip leading `VAR=value` assignments and delegating wrappers (`npx`,
 * `sudo`, `pnpm exec`, ...) plus their flags, so classification sees the real
 * command. `npx -y biome check .` reduces to `biome check .`. Redirections are
 * left in place: they trail the command (`tsc 2>&1`), and classification only
 * reads the head.
 */
function unwrap(part: string): string {
  let s = part.trim();
  // Leading environment assignments.
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  const { rest } = stripWrapperTokens(s.split(/\s+/).filter(Boolean));
  return rest.join(' ').trim();
}

/** Classify an already-unwrapped command as a direct verifier invocation. */
function directVerifier(s: string): string | null {
  for (const re of VERIFIER_PAIRS) {
    const m = s.match(re);
    if (m) return m[0].replace(/\s+/g, ' ');
  }
  const direct = s.match(VERIFIER_PATTERN);
  return direct ? direct[1] : null;
}

/**
 * Name the verifier a pipeline segment starts with, or null. `scripts` lets
 * `npm run typecheck` resolve through package.json to its body -- the handoff's
 * condition 1 explicitly covers script indirection, and skipping it would miss
 * the most common documented spelling.
 */
export function verifierName(part: string, scripts?: Record<string, string>): string | null {
  const s = unwrap(part);
  if (!s) return null;

  const direct = directVerifier(s);
  if (direct) return direct;

  // One level of script indirection. Not recursive: a script body that itself
  // runs another script is rare, and each extra hop widens the blast radius.
  const runner = s.match(SCRIPT_RUNNER)?.[1];
  const shorthand = runner ? undefined : s.match(SCRIPT_SHORTHAND)?.[1];
  const scriptName = runner ?? (shorthand ? NPM_LIFECYCLE_SHORTHANDS[shorthand] : undefined);
  if (!scriptName) return null;
  const body = scripts?.[scriptName];
  if (typeof body === 'string') {
    const first = splitPipes(splitSegments(body)[0]?.text ?? '')[0] ?? '';
    return directVerifier(unwrap(first));
  }
  // Not a script: pnpm/yarn/bun then run the local binary of that name, so
  // `pnpm tsc --noEmit` IS `tsc --noEmit`. npm does not (`npm run tsc` with no
  // such script just fails), so only the bare runners fall through.
  const bare = s.match(BARE_RUNNER_PREFIX);
  return bare ? directVerifier(s.slice(bare[0].length)) : null;
}

/** Name the filter a pipeline segment starts with, or null. */
export function filterName(part: string): string | null {
  const m = unwrap(part).match(FILTER_PATTERN);
  return m ? m[1] : null;
}

/** True when a segment is an `echo`/`printf` announcing success. */
function isSuccessClaim(segment: string): boolean {
  if (!/^(echo|printf)\b/.test(unwrap(segment))) return false;
  const m = SUCCESS_WORD.exec(segment);
  if (!m) return false;
  return !NEGATION_BEFORE.test(segment.slice(0, m.index).replace(ZERO_COUNT, ' '));
}

/**
 * True when a segment reports `$?` -- which, right after a pipeline, is the
 * FILTER's status. `${PIPESTATUS[0]}` is the correct spelling and is exempt:
 * that is the documented fix, not the defect.
 */
function isStatusEcho(segment: string): boolean {
  if (!/^(echo|printf)\b/.test(unwrap(segment))) return false;
  if (/PIPESTATUS/.test(segment)) return false;
  return /\$\?/.test(segment);
}

/**
 * Analyse one command line. Returns a finding only when ALL of the handoff's
 * conditions hold: a verifier first in the pipeline, a filter last, and a
 * following segment that consumes the (wrong) status as a success signal.
 * `pipefail` is handled by the caller via {@link pipefailInScope} because it
 * needs the surrounding fence, but an inline `set -o pipefail &&` in the same
 * command is caught here.
 */
export function analyzeMaskedExitStatus(
  cmd: string,
  scripts?: Record<string, string>,
): MaskedExitStatus | null {
  const segments = splitSegments(cmd);
  if (segments.length < 2) return null;

  for (let i = 0; i < segments.length - 1; i++) {
    // `set -o pipefail` earlier in this same command line restores the real
    // status for everything after it.
    if (segments.slice(0, i + 1).some((s) => PIPEFAIL.test(s.text))) return null;

    const parts = splitPipes(segments[i].text);
    if (parts.length < 2) continue;

    const verifier = verifierName(parts[0], scripts);
    if (!verifier) continue;
    const filter = filterName(parts[parts.length - 1]);
    if (!filter) continue;

    const next = segments[i + 1];
    // `||` reads the failure branch, which is not a false success claim.
    if (next.op !== '&&' && next.op !== ';') continue;
    // `;` only masks via an explicit `$?` read -- a bare `; echo done` after a
    // pipeline claims nothing about the pipeline.
    if (next.op === '&&' && isSuccessClaim(next.text)) {
      return { verifier, filter, claim: next.text, kind: 'success-claim' };
    }
    if (isStatusEcho(next.text)) {
      return { verifier, filter, claim: next.text, kind: 'status-echo' };
    }
  }
  return null;
}

/**
 * True when a `set -o pipefail` is in scope for `line` (1-indexed).
 *
 * Scope is the enclosing fenced code block: shell options do not survive
 * across fences, and a `pipefail` in an unrelated snippet elsewhere in the doc
 * says nothing about this one. A command outside any fence has no shell scope
 * to inherit, so it returns false.
 */
export function pipefailInScope(content: string, line: number): boolean {
  const lines = content.split('\n');
  const idx = line - 1;
  if (idx < 0 || idx >= lines.length) return false;

  const block = fenceBlocks(lines).find((b) => b.open < idx && idx < b.close);
  if (!block) return false;
  for (let i = block.open + 1; i < idx; i++) {
    if (PIPEFAIL.test(lines[i])) return true;
  }
  return false;
}

/** One fenced code block, by 0-indexed line. */
export interface FenceBlock {
  /** The opening delimiter line. */
  open: number;
  /**
   * The closing delimiter line, or the first line past the block when it is
   * unterminated. The body is always `open + 1 .. close - 1`.
   */
  close: number;
  /** Info string after the opening delimiter (`bash`, `console`, ...), trimmed. */
  info: string;
}

// `[^\n]*`, not `.*`: `.` stops at `\r`, so a CRLF file's info string would
// fail to match and every fence would read as untagged.
const FENCE_DELIM = /^\s*(`{3,}|~{3,})([^\n]*)$/;

/**
 * Fenced code blocks of a markdown line array.
 *
 * Fence MEMBERSHIP comes from utils/markdown.ts -- the same state machine the
 * prose checks use -- so this file and cli-subcommands.ts can no longer drift
 * from it (both used to hand-roll a tracker, and both got HTML comments and
 * fences wrong in different ways). This only splits that mask into blocks and
 * reads each opener's info string, which the shared mask does not expose. The
 * delimiter regex accepts `~~~` as well as backticks, so blocks of either kind
 * come out right as soon as the shared mask recognises them.
 */
export function fenceBlocks(lines: string[]): FenceBlock[] {
  const nonProse = nonProseLineMask(lines);
  const comment = htmlCommentLineMask(lines);
  const fenced = (i: number) => nonProse[i] === true && comment[i] !== true;

  const out: FenceBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!fenced(i)) {
      i++;
      continue;
    }
    const m = FENCE_DELIM.exec(lines[i]);
    const marker = m ? m[1][0] : '`';
    const closer = new RegExp(`^\\s*${marker === '`' ? '`' : '~'}{3,}`);
    let j = i + 1;
    while (j < lines.length && fenced(j) && !closer.test(lines[j])) j++;
    out.push({ open: i, close: j, info: m ? m[2].trim() : '' });
    // A closer line is consumed; a block that ended because the mask did
    // (unterminated at EOF) resumes scanning at j.
    i = j < lines.length && fenced(j) ? j + 1 : j;
  }
  return out;
}
