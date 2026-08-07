# Tailnet MCP

## Too many tools? Subset them.

89 tools is a lot. Trim what this one exposes.

- **`minimal`** (20 tools) — observe only.
- **`core`** (47 tools) — the day-to-day admin surface.
- **`full`** (89 tools, default) — everything.

## Tool reference

<details>
<summary><strong>Status</strong> (1 tool)</summary>
</details>

<details>
<summary><strong>Devices</strong> (17 tools)</summary>
</details>

<details>
<summary><strong>DNS</strong> (11 tools)</summary>
</details>

<details>
<summary><strong>Local CLI</strong> (4 tools, opt-in)</summary>
</details>

<!--
  POSITIVE CASE. The enumerated parts sum to 1 + 17 + 11 + 4 = 33, but the
  stated total is 89. Expected: one claims/total-vs-parts warning naming both
  numbers.

  This is the shape of the real defect: the parts and the total drifted because
  one group is opt-in and additive, and no one recomputed the total. The fix in
  the source repo was to state the reconciliation explicitly.
-->
