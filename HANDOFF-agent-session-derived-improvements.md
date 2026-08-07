# Handoff: three improvements derived from a live agent session

**Inspected at:** v0.18.7 (`HEAD 4edcace`, branch `feat/session-derived-rule-specs`)
**Source of evidence:** a full working session on `@yawlabs/caddy-mcp` (sibling repo) where ctxlint ran at session start, produced three findings, and the agent then spent the session doing the work those findings pointed at. Two of the three findings held up; one was a false positive. Everything below is grounded in what actually happened, with `file:line` into this repo.

Two items from that session are **already fixed in the working tree** and are not covered here:

- `translateMsysDrivePath` now accepts a doubled leading slash (`src/core/checks/hook-coverage.ts:176`).
- `dead-hook` now distinguishes a missing target from a wrong path form (`src/core/checks/hook-coverage.ts:262`).

This doc specs the three that are design changes rather than bug fixes. No catalog changes, matching the convention set by `4edcace`.

---

## 1. `staleness` should name WHAT is stale, not just that it is

**Rule:** `staleness/stale` — `src/core/checks/staleness.ts:106`

**What happened.** ctxlint reported:

> `CLAUDE.md:1 (staleness/stale) Last updated 83 days ago. src/api.ts has 4 commits since.`

That was **correct and useful** — the file really was stale. But it took a manual read of both `CLAUDE.md` and every source file to learn *how*. The doc was missing:

- an entire module (`src/snapshots.ts`)
- two of eighteen tools (`caddy_revert`, `caddy_remove_route`)
- three of five environment variables (`CADDY_TIMEOUT`, `CADDY_LOAD_TIMEOUT`, `CADDY_MAX_RETRIES`)

The check already knows the context file's referenced paths (`staleness.ts:32-40` builds `referencedPaths`), and already runs git over them. It stops one step short of the answer.

**Proposal.** A companion rule — `staleness/undocumented-entity` — that, for context files which reference source paths, extracts *named entities* from those sources and reports the ones the doc never mentions:

| Entity | Extraction | Rationale |
|---|---|---|
| Module files | files under a referenced directory | a doc listing `src/*.ts` line by line should list all of them |
| `process.env.X` reads | regex over source | env vars are the highest-value undocumented thing; they are invisible from the outside |
| Exported symbols | `export function/const/class` | catches a public API the doc predates |

Report shape: `CLAUDE.md documents src/ but does not mention: src/snapshots.ts, CADDY_TIMEOUT, CADDY_LOAD_TIMEOUT`.

**Why it is worth the complexity.** This converts a *prompt to go look* into a *diff to go apply*. The existing rule's value is capped by the fact that acting on it requires the same manual audit whether the doc is 5% or 95% stale.

**False-positive risk, and the guard.** A doc deliberately summarizing rather than enumerating would light up. Guard: only fire when the doc *already* mentions a majority of the entities in a class (it is clearly trying to be exhaustive), and stay `info` severity. A doc listing 8 of 10 modules wants to know about the other 2; a doc listing 0 of 10 is not that kind of doc.

---

## 2. MCP tool DESCRIPTIONS are agent-context, and ctxlint cannot currently see them

**Current scope:** the `mcp` pillar lints `.mcp.json` **config** (`ParsedMcpConfig`, `src/core/checks/mcp/schema.ts:1`) — server wiring, env, URLs, security. It never reads server *source*.

**What happened.** The session found two contradictions between an MCP server's tool descriptions and its implementation, in one repo:

1. `caddy_metrics`' description claimed filter mode drops the `# EOF` marker; the code preserved it unconditionally. An agent planning against that description would have worked around a problem that did not exist.
2. `caddy_load` carried `destructiveHint: true` and replaced the entire server config, with **no** confirmation parameter — while four sibling tools in the same server gated on `confirm=true`.

A tool description is agent-context in exactly the sense this project cares about: it is text an agent reads and plans against, and when it drifts from the code the agent is confidently wrong. It is the same failure class as a stale `CLAUDE.md`, one layer down.

**The honest constraint.** Checking descriptions against handler behavior in general requires reading and understanding TypeScript source — a new pillar, not a check. **Do not build that.** But two useful subsets are pure structure, needing only the registration call's arguments:

- **`mcp-tools/confirm-claim-mismatch`** — the description says "requires confirm" / "confirm=true" but the input schema has no `confirm` property, or the schema has a `confirm` property the description never mentions.
- **`mcp-tools/destructive-without-gate`** — `destructiveHint: true` with no confirmation-shaped parameter, especially when sibling tools in the same file have one. The sibling comparison is what makes this precise rather than nagging.

Both are decidable from the AST of a `server.tool(...)` call. Neither needs to understand the handler.

**Open question for whoever picks this up:** does this belong in ctxlint at all, or in a separate `mcp-server-lint` pillar? It is a different input class (source files, not config), which is an architectural decision, not a coding one.

---

## 3. Findings need a confidence signal, because session-start output is read as fact

**What happened.** ctxlint ran at session start and emitted three warnings. **One of the three was wrong** — the `//c/...` dead-hook false positive fixed above. Its suggestion was *"remove the dead entry"*, and the agent came close to deleting a legitimate, working permission grant on that advice. It only survived because the agent probed the path before acting.

That is a 33% false-positive rate on a surface that is, by construction, read before any verification has happened — and whose remedies include destructive ones.

**Proposal.** A `confidence` field on `LintIssue`, with two values:

- **`verified`** — the finding is decidable from what was read. A JSON parse error. A file absent under every path reading. A duplicate key.
- **`heuristic`** — the finding rests on an inference. Staleness by commit count. Prose that *looks* like a path. Anything where the check guessed at intent.

Consumers use it differently:

- The **CLI** prints heuristic findings under a visually distinct marker.
- The **session-start hook** tells the agent to probe heuristic findings before acting, and may act directly on verified ones.
- **`--fix`** touches `verified` only. (It already declines the risky cases; this makes the criterion explicit rather than per-rule folklore.)

**Why this beats more per-rule tuning.** `HANDOFF-paths-false-positives.md` documents the same shape from a different rule: correct-but-confident wrongness diluting real signal. Each individual false positive is worth fixing, and both of those are being fixed — but the *class* recurs because some checks are inherently inferential. Labelling them is a structural answer, and it also gives permission to ship a useful-but-noisy heuristic rule that would otherwise be unshippable at `warning`.

**Migration.** Default `confidence: 'verified'` so existing rules keep today's behavior, then reclassify deliberately. Candidates for `heuristic` on day one: `staleness/*`, `ctxlint/paths` (per the other handoff), `redundancy/*`.

---

## Suggested order

1. **(3)** first — it is a small type change plus a reclassification pass, and it de-risks everything after it.
2. **(1)** next — highest value per line, self-contained in `staleness.ts`.
3. **(2)** last, and only after the architectural question is answered.
