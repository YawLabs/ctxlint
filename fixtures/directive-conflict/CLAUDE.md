---
description: Always-loaded project instructions.
---

# Project instructions

## Orchestration

Do not use workflows or sub-agents unless the user explicitly requested it.

## Testing

Always run the full suite before committing.

<!--
  POSITIVE CASE, half one. Pairs with AGENTS.md, which tells the agent to
  DEFAULT to workflows for every substantive task. Both files are always-loaded,
  so both directives are live on every turn and the agent must silently pick.

  Observed live in a real session: a base instruction said "do not use workflows
  unless requested" while an always-loaded overlay said "default to authoring
  and running a Workflow for every substantive task".

  Expected: one contradictions/directive-conflict warning citing both files,
  on the normalized subject "workflows".
-->
