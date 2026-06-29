# Handoff: `ctxlint/paths` false positives on directory-diagram fences and lowercase slash-prose

**Inspected at:** v0.18.2 (`HEAD 79a0f0c`)
**Reported from:** the `typed` repo (`@yawlabs/typed`), where a session-start `ctxlint` run reported **13 `ctxlint/paths` errors on `.claude/CLAUDE.md`, all false positives** (plus a stale "N auto-fixable" count — see note 4). None are real broken paths; the file is correct.

This doc is grounded in the actual source so it's actionable: every claim cites `file:line`, there's a copy-paste repro, and ready-to-add regression fixtures.

---

## TL;DR

`extractPathReferences` (`src/core/parser.ts:128`) over-extracts path candidates in two situations, and the downstream `paths` check (`src/core/checks/paths.ts`) then reports them as broken:

1. **Bare/unlabeled code fences are scanned.** A `directory-layout DIAGRAM` written in an unlabeled ` ``` ` fence has every tree child (`api/`, `db/`, ...) extracted as a path ref relative to repo root, where they don't exist (the real paths are `apps/api/`, `packages/db/`). The path extractor skips fences only when `isExampleCodeBlock(lang)` is true, and unlabeled (`''`) fences are deliberately excluded from that set (`parser.ts:148-151`, `isExampleCodeBlock:212-245`). **This is inconsistent with `checks/skills.ts checkBrokenRefs`, which the code comment at `parser.ts:217-218` says *does* skip bare fences.**

2. **Lowercase slash-prose slips past the prose guards.** Tokens like `unit/integration` (from "unit/integration tests"), `skill/agent`, `content/length`, `build/seed/probe/lint` match `PATH_PATTERN` and are reported as missing directories. The existing prose guard (`parser.ts:171-177`) only skips `Capitalized/Capitalized` (`Biome/Prettier`, `Jest/Vitest`) — lowercase prose has no equivalent guard.

Net effect: a clean, correct CLAUDE.md produces a wall of confident-but-wrong "directory does not exist" errors, which dilutes the signal so a *real* broken path (the kind `ctxlint/paths` is meant to catch) is easy to miss.

---

## Repro (minimal)

`fixtures/<name>/CLAUDE.md`:

    # Repro

    ## 5. Project layout

    ```
    apps/
      api/        the api service (content/length router)
    packages/
      db/         drizzle schema + forward-only migrations
    scripts/      release.sh + build/seed/probe/lint scripts
    ```

    ## Stack

    - Vitest for unit/integration tests.
    - Maintaining skill/agent path references when code moves.

Running `ctxlint` against this reports (all false positives):

    x  api/ directory does not exist
    x  db/ directory does not exist
    x  content/length does not exist
    x  build/seed/probe/lint does not exist
    x  unit/integration does not exist
    x  skill/agent does not exist

Every one of these is either a tree node in a layout diagram or a slash-bearing prose phrase. None is a file/dir reference.

### Real-world evidence (typed `.claude/CLAUDE.md`)

The section-5 directory layout is an unlabeled fence (`.claude/CLAUDE.md:47`):

    ```
    apps/
      api/        typed-api: Anthropic-compatible proxy + content/length router
      indexer/    typed-indexer: ...
    packages/
      db/         Drizzle schema + forward-only migrations
      ...
    ```

That single block produced 9 of the 13 errors (`api/ indexer/ dashboard/ db/ knowledge-base/ retrieval/ routing/`, plus `content/length` and `build/seed/probe/lint` from the inline descriptions). The other 4 came from prose elsewhere in the file: `unit/integration` ("Vitest for unit/integration tests"), `skill/agent` ("skill/agent path references rot"), and `meta/*_snapshot.json` / `meta/NNNN_snapshot.json` (relative mentions of `packages/db/migrations/meta/` — see note 3).

---

## Root cause, by `file:line`

### Bug A — bare fences are scanned (`src/core/parser.ts`)

- `extractPathReferences` tracks fences (`:130-146`) but only `continue`s past a fence when `isExampleCodeBlock(codeBlockLang)` is true (`:148-151`).
- `isExampleCodeBlock` (`:212-245`) returns `true` only for a known language allow-list; **unlabeled (`''`) fences return `false`** and are therefore scanned. The comment at `:214-218` makes this explicit and even notes the inconsistency: `checks/skills.ts checkBrokenRefs` SKIPS bare fences, but this path extractor does not.
- A directory-layout diagram is the common bare-fence content that is NOT a set of file references. `PATH_PATTERN` (`:35-36`) matches a bare `api/` because the pattern allows a trailing-empty segment after `name/`.

### Bug B — lowercase slash-prose not guarded (`src/core/parser.ts`)

- The prose guard at `:171-177` skips only `^[A-Z][\w.-]*\/[A-Z][\w.-]*$` (Capitalized/Capitalized, no extension).
- Lowercase `word/word` prose (`unit/integration`, `skill/agent`, `content/length`) and multi-segment lowercase (`build/seed/probe/lint`) have no equivalent guard, pass the `value.includes('/')` test at `:187`, and are emitted as refs.
- `PATH_EXCLUDE` (`:39-40`) hard-codes a few case-specific prose escapes (`I/O|i/o|w/o|n/a|e.g.`) but nothing general.

The downstream reports come from `src/core/checks/paths.ts`: the "directory does not exist" message at `:158`, "does not exist" at `:252`, and "matches no files" (glob) at `:142`.

---

## Suggested fixes (options, not prescriptions — maintainer owns the call)

**For Bug A** (pick one):
- **(A1) Align with `skills.ts`: skip bare/unlabeled fences in `extractPathReferences` too.** Simplest and removes the documented inconsistency (`parser.ts:217-218`). Tradeoff: a bare fence *can* contain a real usage example with a genuine path (`src/foo.ts`) — but `skills.ts` already made the call that bare fences are usage examples to skip, so this just makes the two extractors consistent.
- **(A2) Detect directory-diagram fences specifically** and skip only those (e.g. a fence where most non-blank lines match `^\s*[\w.@-]+/\s` — a `name/` followed by description text, with tree-style indentation). More surgical; preserves real path refs in other bare fences. More code.

**For Bug B:**
- Widen the prose guard at `parser.ts:171-177` to also skip **lowercase** `word/word` with no extension and no path prefix (`./`, `../`, leading `/`, or a known top-level dir). Same shape as the existing Capitalized rule, case-relaxed. Tradeoff: a real lowercase ref with no extension (`src/utils`) would also be skipped — but the existing Capitalized rule already accepts that class of tradeoff, and extension-less bare refs are rare and low-value to validate.

A combined heuristic worth considering: **only treat a slash-token as a path if it has a file extension, OR a path prefix (`./ ../ /`), OR a recognized top-level segment (`src/ apps/ packages/ scripts/ docs/ ...`), OR 3+ segments.** That flips the default from "any slash-token is a path unless excluded" to "a slash-token is prose unless it looks like a path," which structurally kills both bug classes — but it's a bigger behavior change and needs its own fixture sweep.

---

## Suggested regression coverage

- Add a fixture (e.g. `fixtures/diagram-and-prose/CLAUDE.md`) with the minimal repro above, and assert `ctxlint/paths` returns **zero** findings for it.
- Add focused cases to `src/core/checks/__tests__/paths.test.ts`:
  - a bare-fence directory diagram → no path findings;
  - `unit/integration`, `skill/agent`, `content/length` in prose → no path findings;
  - **negative control:** a genuinely broken ref (`src/does/not/exist.ts`) in the same file still IS reported (so the fix narrows false positives without blinding the check).

The negative control matters: in the typed repo, `ctxlint/paths` previously caught a *real* stale path in CLAUDE.md (a `meta/_journal.json` ref that needed the full `packages/db/migrations/` prefix), so the check earns its keep — the goal is to cut the noise without losing that.

---

## Notes

1. **Don't "fix" this on the consumer side.** Mangling the CLAUDE.md directory diagram or rewording prose to dodge the parser degrades good docs; a coarse `--ignore ctxlint/paths` or a file-glob `.ctxlintignore` on CLAUDE.md would silence the *whole* path check on that file and mask real broken paths. The fix belongs here in the extractor.
2. **Scope.** Bug A handles the bulk (every tree child + the in-fence descriptions). Bug B handles the out-of-fence prose. They're independent and can land separately.
3. **Lower-priority, separate:** `meta/*_snapshot.json` (`paths/glob-no-match`, `checks/paths.ts:142`) and `meta/NNNN_snapshot.json` are *relative mentions* of `packages/db/migrations/meta/` in prose. These genuinely look like paths/globs, so they're a harder call than A/B and may be acceptable to leave (or addressed by the "recognized top-level segment" heuristic above). Flagging, not prescribing.
4. **Session-start over-count.** The host hook advertised "13 auto-fixable broken paths," but `ctxlint --fix-dry-run` reports **"No auto-fixable issues."** Worth reconciling how the auto-fixable count is computed vs. what `--fix` actually resolves, so the session-start summary doesn't over-promise.
