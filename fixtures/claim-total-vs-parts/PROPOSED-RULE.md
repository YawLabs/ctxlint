# Fixture for a proposed rule: `claims/total-vs-parts` (not implemented)

No check reads this fixture yet. It is kept as the test case for a rule that was
specced in #52 (commit `a357c46`) but never built. Three of that PR's five
proposed rules shipped (`commands/unknown-subcommand`,
`commands/exit-status-masked`, `session/unresolvable-sha`); this one and
`contradictions/directive-conflict` did not. The handoff that specced them was
later deleted (`09f437c`), so this note is the remaining pointer.

**The rule:** a document states a total (`89 tools`) and separately enumerates
parts (`(1 tool)`, `(17 tools)`, ...). When the parts partition the total, they
must sum to it. In the source repo the README said 89 while its sections summed
to 93, for several releases.

**What the fixture encodes:**

- `CLAUDE.md` -- the positive case: a stated total that disagrees with a
  structurally sibling set of parts.
- `AGENTS.md` -- the negative control: overlapping subset counts (profile
  bullets) that are _not_ a partition. Summing every `(N tools)` on the page
  fires here and is wrong; only a sibling set (same-depth list items, table
  rows, `<summary>` elements) counts. If no sibling set can be identified with
  confidence, emit nothing.

**Full spec** (catalog entry, algorithm, false-positive boundary):

```sh
git show a357c46:HANDOFF-session-derived-rules.md   # section 1
```

Landing order when implementing: emitter and tests first, then the catalog
entry and spec row in the same change (catalog-consistency.test.ts fails on a
catalog rule with no emitter).
