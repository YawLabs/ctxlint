# Project notes

## History

- CI was removed in `1b18b85` -- this repo now has no GitHub Actions workflows.
- The Zod 4 validator migration landed in commit deadbee.
- See `0000000000000000000000000000000000000000` for the import.

## Not SHAs (negative controls)

- Bumped `@types/node` to 26.1.1 and biome to 2.5.4.
- The cache key is `abcdef` in the config below.
- Colour tokens: `#a1b2c3` and `beadfaced` appear in the theme.

```bash
# Inside a fence -- must not be scanned.
git show 1234567
```

<!--
  POSITIVE CASES: `1b18b85` and `deadbee` are SHA-shaped; whether they resolve
  depends on the repo under test, which is the point -- the check is
  `git cat-file -t <sha>`, not a pattern match.

  NEGATIVE CONTROLS, in order of how easily a naive regex gets them wrong:
    - 26.1.1 / 2.5.4  -> version numbers, not hex tokens
    - `abcdef`        -> hex-shaped but only 6 chars (min length is 7)
    - `#a1b2c3`       -> hex COLOUR, must be excluded by the leading #
    - `beadfaced`     -> 9 hex chars and a real English-ish word; this one only
                         survives because the check RESOLVES it rather than
                         trusting the shape. A pattern-only rule fires here.
    - fenced `git show 1234567` -> code fences are not scanned

  Honest scope note: the crisp, low-false-positive form of this rule catches
  SHAs that no longer resolve (squash-merge rewrites, rebased-away commits,
  typos). The motivating real-world instance was subtler -- a memory attributed
  the CI removal to a SHA that DOES resolve but is not the commit that made the
  change. That attribution check is a stretch goal, not v1. See the handoff.
-->
