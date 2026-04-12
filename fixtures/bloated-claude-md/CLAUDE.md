# Project

Short intro.

## Small section

A couple lines of context.

- Use `npm test` for tests.
- Use `npm run build` for builds.

## Pre-commit checklist

This section is deliberately large to simulate a common bloat pattern where
a project's pre-commit ritual grows over time and ends up dominating the
always-loaded context budget.

Before every commit:

1. Run `npm run lint:fix` — Biome/Prettier formatting diffs break CI, so
   auto-format before pushing. If the formatter makes changes, review them,
   stage them, and rerun the linter to confirm the tree is clean. This is
   non-negotiable because our release workflow runs `lint` (not `lint:fix`)
   and will reject any unformatted diff. Do not skip this step even for
   one-line changes; the formatter will occasionally reflow nearby lines
   and the only way to catch it is to let it run.
2. Run the full test suite with `npm test`. Do not commit with failing
   tests. If a test is flaky, open an issue instead of retrying — we had a
   production incident last quarter caused by a "it's just flaky" test
   that turned out to be catching a real race condition. The postmortem
   concluded that retries masked the signal for six weeks before the
   eventual prod failure.
3. If writing new tests, run them first against the unmodified code to
   verify the assertions match actual behavior. Tests that pass on green
   but were never seen to fail are a known antipattern here. The team has
   a standing rule: every new test must be seen to fail on the pre-change
   state before being committed, otherwise you do not know what it is
   actually asserting.
4. Check that any new environment variables are documented in `.env.example`
   and in the README's Configuration section. CI will fail the build if a
   referenced env var is missing from `.env.example`. The check lives in
   scripts/check-env.ts and runs as part of the ci workflow; look there if
   you want to understand what counts as a reference.
5. Verify no secrets, tokens, or credentials are in the diff. Run
   `git diff --staged` and scan for anything that looks like a key. We use
   trufflehog in CI but don't rely on it as the only line of defense.
   Historical incident: a personal access token made it into a commit in
   2024 and was caught only because a reviewer happened to notice the
   unfamiliar string shape.
6. Update `CHANGELOG.md` under the Unreleased heading. Group entries by
   Added / Changed / Fixed / Removed. Keep entries terse — one line each,
   user-facing language, no PR numbers (the release script generates those
   from git log). If an entry needs more than a sentence, the entry is
   probably covering more than one change and should be split.
7. If the change touches the public API surface — exported types, CLI
   flags, config schema — bump the minor version in package.json. Breaking
   changes get a major bump and a migration note in CHANGELOG.md's Removed
   section with a link to the deprecation issue. Check the "Public API"
   section of the README for the current definition of what counts as
   part of the public surface; anything not listed there is internal.
8. Run `npm run build` and confirm the output in `dist/` is reasonable.
   The build script is the thing users actually consume, so a green test
   suite does not substitute for a successful build. Peek at the bundle
   with `ls -la dist/` and sanity-check the sizes; if something ballooned
   unexpectedly, a dependency probably got pulled in by mistake.
9. If the change adds a new dependency, run `npm run dep-check` and
   justify the addition in the PR description. We prefer fewer dependencies
   and larger local utilities, because every transitive dependency is a
   supply-chain risk and an upgrade burden we inherit forever.
10. For UI changes, start the dev server and manually verify the change
    in a browser against the golden path and two edge cases. Automated
    tests are not a substitute for looking at the feature with human eyes.

If anything in this checklist fails, do not "fix it in a followup" — the
followup always takes longer than people estimate and we end up with a
broken main branch. Fix it now or back out the change. This rule exists
because we've repeatedly seen "small followups" turn into multi-week tails
of rot; the blast radius of a broken main is much higher than the cost of
spending fifteen extra minutes to land a clean change.

## Architecture

The codebase is organized into three layers: CLI, core, and checks.

- `src/cli.ts` — command-line entrypoint
- `src/core/` — audit orchestration, parsing, reporting
- `src/core/checks/` — individual lint rules

Each check exports a single async function that takes a parsed file and
returns a list of issues. Keep checks pure and side-effect-free.

## Notes

Random trailing note.
