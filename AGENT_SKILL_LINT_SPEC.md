# AI Agent Skill Linting Specification

**Version:** 1.0.0-draft
**Date:** 2026-06-02
**Maintained by:** [Yaw Labs](https://yaw.sh) / [ctxlint](https://github.com/YawLabs/ctxlint)
**License:** CC BY 4.0

---

## What is this?

AI coding agents are increasingly extended with **skills** and **subagents** -- reusable, named units of behavior the agent loads on demand. In Claude Code these live as:

- **Skills:** `~/.claude/skills/<name>/SKILL.md` -- a markdown file with YAML frontmatter (`name`, `description`) plus a body of instructions.
- **Agents (subagents):** `~/.claude/agents/*.md` -- a markdown file with frontmatter (`name`, `description`, optional `tools` restriction) plus a body.

These definition files have the same failure modes as context files: their frontmatter goes missing, their body references paths that no longer exist, their trigger phrases collide so the wrong one fires, a skill directory is left without a `SKILL.md`, or a subagent restricts itself to a tool name that doesn't exist. When that happens the skill/agent silently misbehaves -- it never fires, fires for the wrong prompt, or runs with the wrong tool set.

This specification defines a standard set of lint rules for validating agent-skill definitions. It is the **fourth pillar** alongside context-file linting, MCP-config linting, and session-data linting:

| Pillar | What it checks | Specification |
|---|---|---|
| Context files | Instructions the agent reads | [CONTEXT_LINT_SPEC.md](./CONTEXT_LINT_SPEC.md) |
| MCP configs | Tools the agent can use | [MCP_CONFIG_LINT_SPEC.md](./MCP_CONFIG_LINT_SPEC.md) |
| Session data | History and memory the agent carries | [AGENT_SESSION_LINT_SPEC.md](./AGENT_SESSION_LINT_SPEC.md) |
| Agent skills | Skills and subagents the agent loads | This document |

**v1 scope is deliberately tight: Claude Code only** (`~/.claude/skills/<name>/SKILL.md` and `~/.claude/agents/*.md`). Other agents' skill/subagent formats may be added in later spec versions.

**Reference implementation:** [ctxlint](https://github.com/YawLabs/ctxlint) -- run via `ctxlint --skills` (or `--skills-only`).

---

## 1. Agent Skill Landscape Reference

### 1.1 Data sources (v1)

| Kind | Location | Required frontmatter |
|---|---|---|
| Skill | `~/.claude/skills/<name>/SKILL.md` | `name`, `description` |
| Agent (subagent) | `~/.claude/agents/<name>.md` | `name`, `description` (optional `tools` / `allowed-tools`) |

The skill `<name>` is the directory name; the agent `<name>` is the filename without `.md`. A `~/.claude/skills/<name>/` directory with no `SKILL.md` is an **orphaned skill** -- the directory exists but Claude Code has nothing to load.

### 1.2 Scan targets

Skill/agent definitions live in the user-global `~/.claude/` tree, NOT inside the project. The checks therefore scan the home directory, like the session pillar -- they are opt-in (`--skills`) for the same reason: they read files outside the project directory.

---

## 2. Lint Rules

5 rules in 1 category (`skill`). All rules audit Claude Code skill (`SKILL.md`) and agent (`.md`) definition files.

Severity levels:
- **error** -- the definition is structurally broken (e.g. unclosed or absent frontmatter). The skill/agent will not load as intended.
- **warning** -- the definition has a likely problem worth investigating (missing field, broken reference, trigger collision, dead tool restriction).
- **info** -- reserved for future advisory rules.

### 2.1 skill — agent skill audit

| Rule ID | Severity | Trigger | Message |
|---|---|---|---|
| `skill/missing-frontmatter` | warning (error when frontmatter absent/unclosed) | A SKILL.md / agent .md has no `---`-delimited frontmatter, has unclosed frontmatter, or is missing a required field (`name`, `description`) | `{file}: missing required frontmatter field "{field}"` |
| `skill/broken-ref` | warning | A `./` or `../` path reference in the body (outside example code blocks) does not exist relative to the skill directory | `{file}: references "{path}" which does not exist relative to the skill directory` |
| `skill/trigger-collision` | warning | A normalized trigger phrase (quoted phrase in the description, or a `trigger`/`triggers` field) is declared by more than one distinct skill/agent | `Trigger phrase "{trigger}" is declared by {count} skills/agents — only one will win` |
| `skill/orphaned` | warning | A `~/.claude/skills/<name>/` directory contains no `SKILL.md` | `{dir}: skill directory has no SKILL.md — Claude Code has nothing to load` |
| `skill/dead-tool-restriction` | warning (info when the unknown name is PascalCase) | An agent's `tools` / `allowed-tools` frontmatter lists a non-MCP, non-wildcard tool name that is not a known Claude Code built-in tool | `{file}: tool restriction lists "{tool}" which is not a known Claude Code tool` |

**Notes:**

- **`skill/broken-ref`** reuses the path-reference detection shape from the context-file pillar. Only explicitly-relative references (`./`, `../`) are verified, resolved against the skill/agent file's own directory; bare `foo/bar` tokens in prose are too ambiguous to resolve without false positives, so they are skipped. References inside example code blocks (`ts`, `py`, `json`, ...) are excluded.
- **`skill/trigger-collision`** extracts triggers from quoted phrases inside the `description` (e.g. `"ship 1.3.X"`) and from an optional `trigger`/`triggers` field. Phrases are lowercased and whitespace-collapsed before comparison.
- **`skill/dead-tool-restriction`** validates only against the known built-in tool set. MCP-namespaced tools (`mcp__server__tool`) and wildcard entries are skipped because their validity depends on the loaded MCP servers, which the linter cannot see statically. Severity is split by name shape: an unknown **PascalCase** name is reported as *info* -- it may be a built-in newer than the linter's known-tool list, which drifts across Claude Code versions; anything else (lowercase, separators) doesn't match Claude Code's tool naming and keeps the *warning* (far more likely a typo).

All v1 rules are marked **experimental** in the catalog -- the heuristics are conservative and may broaden as more skill/agent shapes are observed. Experimental rules bump patch; promotion to stable bumps minor (see `CHANGELOG.md` versioning policy).

---

## 3. Rule Catalog (machine-readable)

A machine-readable JSON catalog of all rules is available at [`agent-skill-lint-rules.json`](./agent-skill-lint-rules.json). It conforms to the shared catalog schema ([`schemas/ctxlint-catalog.schema.json`](./schemas/ctxlint-catalog.schema.json)), like the other three pillars.

Rule IDs use the ctxlint `category/slug` format (see [CONTRIBUTING.md](./CONTRIBUTING.md) "Rule ID format" for why this differs from the sibling mcp-compliance project).

---

## 4. Implementing This Specification

1. Discover skill files (`~/.claude/skills/<name>/SKILL.md`) and agent files (`~/.claude/agents/*.md`). Record each `~/.claude/skills/<name>/` directory that has no `SKILL.md` as an orphaned skill.
2. Parse YAML frontmatter (`name`, `description`, and for agents `tools` / `allowed-tools`).
3. Run the five rules in section 2.1.
4. Report findings against the user-global path (`~/.claude/...`) -- these are not project files.

### Versioning

This spec follows semver:
- **Patch** (1.0.x): Typo fixes, clarifications, no rule changes.
- **Minor** (1.x.0): New rules added, new agents/skill formats documented.
- **Major** (x.0.0): Rules removed or semantics changed in breaking ways.

### Related specifications and tools

- [AI Context File Linting Specification](./CONTEXT_LINT_SPEC.md) -- context file lint rules (the first pillar)
- [MCP Server Configuration Linting Specification](./MCP_CONFIG_LINT_SPEC.md) -- MCP config lint rules (the second pillar)
- [AI Agent Session Linting Specification](./AGENT_SESSION_LINT_SPEC.md) -- session data lint rules (the third pillar)
- [ctxlint](https://github.com/YawLabs/ctxlint) -- reference implementation of all four specifications
