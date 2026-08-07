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

/**
 * Commands whose EXIT STATUS is the reason to run them. Deliberately narrow:
 * a general command piped into a pager is normal shell usage and must stay
 * silent. Only a verification tool's discarded status is a defect.
 */
const VERIFIER_PATTERN = /^(tsc|eslint|biome|vitest|jest|pytest|mypy|ruff|oxlint)\b/;

/** Two-token verifiers, matched before the single-token set. */
const VERIFIER_PAIRS = [/^cargo\s+(test|clippy|check)\b/, /^go\s+(test|vet|build)\b/];

/**
 * Filters and pagers. A pipeline ending in one of these reports ITS status,
 * which is ~always 0 -- that is the whole masking mechanism.
 *
 * `grep` earns its place even though `... | grep -q x && echo found` is a
 * deliberate gate: piping a VERIFIER into grep and then announcing success
 * inverts the meaning (grep exits 0 when it FINDS something, so
 * `tsc | grep error && echo clean` prints "clean" precisely when there are
 * errors). Both readings are defects.
 */
const FILTER_PATTERN = /^(head|tail|grep|egrep|fgrep|sed|awk|less|more|cat|tee|wc)\b/;

/** Package-manager script runners, for resolving `npm run lint` to its body. */
const SCRIPT_RUNNER = /^(?:npm\s+run|(?:pnpm|yarn|bun)(?:\s+run)?)\s+(\S+)/;

/**
 * Script-mapped shorthands (`npm test`, `pnpm lint`) -- the same set
 * commands.ts validates as script references. Matched separately from
 * SCRIPT_RUNNER so a bare `npm install` never gets looked up as a script.
 */
const SCRIPT_SHORTHAND =
  /^(?:npm|pnpm|yarn|bun)\s+(test|start|build|dev|lint|format|check|typecheck|type-check|clean|serve|preview|e2e)\b/;

/** Wrappers that delegate to another command; stripped before classification. */
const WRAPPER_PATTERN = /^(npx|bunx|sudo|time|command|nice)\b/;
const EXEC_WRAPPER_PATTERN = /^(?:pnpm|npm|yarn|bun)\s+(?:exec|dlx)\b/;

/**
 * Words an `echo`/`printf` uses to ANNOUNCE success. The claim has to assert
 * a passing state -- `echo "has errors"` after a grep is honest reporting and
 * stays silent.
 */
const SUCCESS_WORD =
  /\b(ok|okay|clean|pass|passed|passes|passing|green|success|successful|done|all\s+good|no\s+errors|looks\s+good)\b/i;

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
 * Strip leading `VAR=value` assignments, redirections and delegating wrappers
 * (`npx`, `sudo`, `pnpm exec`, ...) plus their flags, so classification sees
 * the real command. `npx -y biome check .` reduces to `biome check .`.
 */
function unwrap(part: string): string {
  let s = part.trim();
  // Leading environment assignments.
  s = s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '');
  // `pnpm exec` / `npm exec` / `yarn dlx` / `bun x` style two-token wrappers.
  const execMatch = s.match(EXEC_WRAPPER_PATTERN);
  if (execMatch) s = s.slice(execMatch[0].length).trim();
  // Single-token wrappers, plus any flags they carry (`npx -y`, `npx -p foo`).
  while (WRAPPER_PATTERN.test(s)) {
    const tokens = s.split(/\s+/).slice(1);
    let i = 0;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      // `-p pkg` / `--package pkg` consume a value.
      if (tokens[i] === '-p' || tokens[i] === '--package') i++;
      i++;
    }
    const next = tokens.slice(i).join(' ');
    if (!next || next === s) break;
    s = next;
  }
  return s.trim();
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

  for (const re of VERIFIER_PAIRS) {
    const m = s.match(re);
    if (m) return m[0].replace(/\s+/g, ' ');
  }
  const direct = s.match(VERIFIER_PATTERN);
  if (direct) return direct[1];

  // One level of script indirection. Not recursive: a script body that itself
  // runs another script is rare, and each extra hop widens the blast radius.
  const scriptName = (s.match(SCRIPT_RUNNER) ?? s.match(SCRIPT_SHORTHAND))?.[1];
  if (scriptName && scripts) {
    const body = scripts[scriptName];
    if (typeof body === 'string') {
      const first = splitPipes(splitSegments(body)[0]?.text ?? '')[0] ?? '';
      const inner = unwrap(first);
      for (const re of VERIFIER_PAIRS) {
        const m = inner.match(re);
        if (m) return m[0].replace(/\s+/g, ' ');
      }
      const d = inner.match(VERIFIER_PATTERN);
      if (d) return d[1];
    }
  }
  return null;
}

/** Name the filter a pipeline segment starts with, or null. */
export function filterName(part: string): string | null {
  const m = unwrap(part).match(FILTER_PATTERN);
  return m ? m[1] : null;
}

/** True when a segment is an `echo`/`printf` announcing success. */
function isSuccessClaim(segment: string): boolean {
  if (!/^(echo|printf)\b/.test(unwrap(segment))) return false;
  return SUCCESS_WORD.test(segment);
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

  let fenceStart = -1;
  let open = false;
  for (let i = 0; i < idx; i++) {
    if (/^\s*```/.test(lines[i])) {
      open = !open;
      fenceStart = open ? i + 1 : -1;
    }
  }
  if (!open || fenceStart < 0) return false;

  for (let i = fenceStart; i < idx; i++) {
    if (PIPEFAIL.test(lines[i])) return true;
  }
  return false;
}
