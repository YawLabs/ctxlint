# Fixture for a proposed rule: `contradictions/directive-conflict` (not implemented)

No check reads this fixture yet. It is kept as the test case for a rule that was
specced in #52 (commit `a357c46`) but never built. Three of that PR's five
proposed rules shipped (`commands/unknown-subcommand`,
`commands/exit-status-masked`, `session/unresolvable-sha`); this one and
`claims/total-vs-parts` did not. The handoff that specced them was later
deleted (`09f437c`), so this note is the remaining pointer.

**The rule:** two always-loaded context files give opposing behavioural
directives on the same subject. `contradictions/conflict` catches mutually
exclusive _config choices_ (pnpm vs yarn); it does not catch directives such as
"do not use workflows unless asked" in one file and "default to running a
workflow for every task" in another. Both are live on every turn and the agent
silently picks one.

**What the fixture encodes:**

- `CLAUDE.md` and `AGENTS.md` -- the opposing directives on one subject (the
  positive case).
- The same two files also share an _identical_ directive ("Always run the full
  suite before committing") as a negative control: agreement is redundancy
  (`redundancy/duplicate-content` owns that), not conflict.

Beware the `NEVER x unless y` escape-hatch form: a polarity flip on a qualified
directive is the likeliest source of noise. This was rated the highest
false-positive risk of the five; consider shipping it at `info` first.

**Full spec** (catalog entry, algorithm, false-positive boundary):

```sh
git show a357c46:HANDOFF-session-derived-rules.md   # section 4
```

Landing order when implementing: emitter and tests first, then the catalog
entry and spec row in the same change (catalog-consistency.test.ts fails on a
catalog rule with no emitter).
