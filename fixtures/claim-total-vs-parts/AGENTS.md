# Reconciled counts (negative control)

## Tool groups

33 tools total.

- **`minimal`** (20 tools)
- **`core`** (29 tools)

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
<summary><strong>Local CLI</strong> (4 tools)</summary>
</details>

<!--
  NEGATIVE CONTROL. Parts sum to 1 + 17 + 11 + 4 = 33 and the stated total is
  33. Expected: NO claims/total-vs-parts finding.

  Note the profile bullets (20, 29) are deliberately present and deliberately
  NOT summed: they are overlapping subsets of the same 33 tools, not disjoint
  parts. A rule that naively adds every "(N tools)" on the page would sum
  20+29+1+17+11+4 and fire here -- which is the primary false-positive risk.
  Only the <summary> sibling set is a partition; the bullets are not.
-->
