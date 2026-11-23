# AI Agent Skill Linting Specification

**Version:** 1.0.0-draft
**Date:** 2026-11-23
**Maintained by:** [Yaw Labs](https://yaw.sh) / [ctxlint](https://github.com/YawLabs/ctxlint)
**License:** CC BY 4.0

---

## What is this?

AI coding agents are increasingly extended with **skills** and **subagents** -- reusable, named units of behavior the agent loads on demand. In Claude Code these live as:

- **Skills:** `~/.claude/skills/<name>/SKILL.md` -- a markdown file with YAML frontmatter (`name`, `description`) plus a body of instructions.
- **Agents (subagents):** `~/.claude/agents/*.md` -- a markdown file with frontmatter (`name`, `description`, optional `tools` / `disallowedTools` restriction) plus a body.

These definition files have the same failure modes as context files: their frontmatter goes missing, their body references paths that no longer exist, their trigger phrases collide so the wrong one fires, a skill directory is left without a `SKILL.md`, or a subagent restricts itself to a tool name that doesn't exist. When that happens the skill/agent silently misbehaves -- it never fires, fires for the wrong prompt, or runs with the wrong tool set.

This specification defines a standard set of lint rules for validating agent-skill definitions. It is the **fourth pillar** alongside context-file linting, MCP-config linting, and session-data linting:

| Pillar        | What it checks                       | Specification                                              |
| ------------- | ------------------------------------ | ---------------------------------------------------------- |
| Context files | Instructions the agent reads         | [CONTEXT_LINT_SPEC.md](./CONTEXT_LINT_SPEC.md)             |
| MCP configs   | Tools the agent can use              | [MCP_CONFIG_LINT_SPEC.md](./MCP_CONFIG_LINT_SPEC.md)       |
| Session data  | History and memory the agent carries | [AGENT_SESSION_LINT_SPEC.md](./AGENT_SESSION_LINT_SPEC.md) |
| Agent skills  | Skills and subagents the agent loads | This document                                              |

**v1 scope is deliberately tight: Claude Code only** (`~/.claude/skills/<name>/SKILL.md` and `~/.claude/agents/*.md`). Other agents' skill/subagent formats may be added in later spec versions.

**Reference implementation:** [ctxlint](https://github.com/YawLabs/ctxlint) -- run via `ctxlint --skills` (or `--skills-only`).

---

## 1. Agent Skill Landscape Reference

### 1.1 Data sources (v1)

| Kind             | Location                           | Required frontmatter                                                            |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| Skill            | `~/.claude/skills/<name>/SKILL.md` | none (`description` recommended; optional `allowed-tools` / `disallowed-tools`) |
| Agent (subagent) | `~/.claude/agents/<name>.md`       | `name`, `description` (optional `tools` / `disallowedTools`)                    |

A skill needs no frontmatter: without a `description` Claude Code uses the first non-empty body line, which rarely says when to use the skill. An agent needs both fields; its `description` decides when Claude Code delegates to it.

The skill `<name>` is the directory name; the agent `<name>` is the filename without `.md`. A `~/.claude/skills/<name>/` directory with no `SKILL.md` is an **orphaned skill** -- the directory exists but Claude Code has nothing to load.

### 1.2 Scan targets

Skill/agent definitions live in the user-global `~/.claude/` tree (`$CLAUDE_CONFIG_DIR` when that is set; findings then show that directory instead of `~/.claude`), NOT inside the project. The checks therefore scan the home directory, like the session pillar -- they are opt-in (`--skills`) for the same reason: they read files outside the project directory. On Windows the home directory is `USERPROFILE` first, then `HOME`.

---

## 2. Lint Rules

5 rules in 1 category (`skill`). All rules audit Claude Code skill (`SKILL.md`) and agent (`.md`) definition files.

Severity levels:

- **error** -- the definition is structurally broken (unclosed frontmatter, or an agent with none). The skill/agent will not load as intended.
- **warning** -- the definition has a likely problem worth investigating (missing required field, broken reference, trigger collision, orphaned skill, dead tool restriction).
- **info** -- an advisory finding: a skill without frontmatter or without a recommended `description`, or an unknown PascalCase tool name that may be a built-in newer than the linter's list.

### 2.1 skill — agent skill audit

| Rule ID                       | Severity                                                                                                                                 | Trigger                                                                                                                                                                                    | Message                                                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `skill/missing-frontmatter`   | error (unclosed; agent without frontmatter); warning (agent missing a required field); info (skill without frontmatter or `description`) | A SKILL.md / agent .md has unclosed frontmatter, an agent has no frontmatter or lacks `name`/`description`, or a skill has no frontmatter or no `description`                              | ``{file}: frontmatter opens with `---` but is never closed``; `{file}: missing YAML frontmatter` (agent); `{file}: missing required frontmatter field "{field}"` (agent); `{file}: no YAML frontmatter` (skill); `{file}: missing recommended frontmatter field "description"` (skill) |
| `skill/broken-ref`            | warning                                                                                                                                  | A `./` or `../` path reference in the body (outside example code blocks) does not exist relative to the skill directory                                                                    | `{file}: references "{path}" which does not exist relative to the skill directory`                                                                                                                                                                                                     |
| `skill/trigger-collision`     | warning                                                                                                                                  | A normalized trigger phrase (quoted phrase in the description, or a `trigger`/`triggers` field) is declared by more than one distinct skill/agent                                          | `Trigger phrase "{trigger}" is declared by {count} skills/agents — only one will win`                                                                                                                                                                                                  |
| `skill/orphaned`              | warning                                                                                                                                  | A `~/.claude/skills/<name>/` directory contains no `SKILL.md`                                                                                                                              | `{dir}: skill directory has no SKILL.md — Claude Code has nothing to load`                                                                                                                                                                                                             |
| `skill/dead-tool-restriction` | warning (info when the unknown name is PascalCase)                                                                                       | An agent's `tools` / `disallowedTools` or a skill's `allowed-tools` / `disallowed-tools` frontmatter lists a non-MCP, non-wildcard tool name that is not a known Claude Code built-in tool | `{file}: tool restriction lists "{tool}" which is not a known Claude Code tool`                                                                                                                                                                                                        |

**Notes:**

- **`skill/broken-ref`** reuses the path-reference detection shape from the context-file pillar. Only explicitly-relative references (`./`, `../`) are verified, resolved against the skill/agent file's own directory; bare `foo/bar` tokens in prose are too ambiguous to resolve without false positives, so they are skipped. References inside unlabeled fences and code, shell or data fences (`ts`, `py`, `bash`, `console`, `json`, `yaml`, ...) are excluded; backtick and `~~~` fences of any length are recognised, and a fence that opens right after another closes is read as a new fence with its own language. Lines inside HTML comments and inline-code command spans (`` `./run.sh 1.2.3` ``) are not resolved.
- **`skill/trigger-collision`** extracts triggers from quoted phrases inside the `description` (e.g. `"ship 1.3.X"`) and from an optional `trigger`/`triggers` field. Phrases are lowercased and whitespace-collapsed before comparison.
- **`skill/dead-tool-restriction`** validates only against the known built-in tool set (refreshed 2026-11-22). Agent `tools` / `disallowedTools` are comma-separated; skill `allowed-tools` / `disallowed-tools` are space- or comma-separated; separators inside a permission specifier's parentheses (`Bash(git add *)`) do not split, and the specifier is dropped before the name is checked. MCP-namespaced tools (`mcp__server__tool`) and wildcard entries are skipped because their validity depends on the loaded MCP servers, which the linter cannot see statically. The suggestion names the case-correct tool when only the case differs (`Did you mean "Read"? Tool names are case-sensitive.`), else points to https://code.claude.com/docs/en/tools-reference. Severity is split by name shape: an unknown **PascalCase** name is reported as _info_ -- it may be a built-in newer than the linter's known-tool list, which drifts across Claude Code versions; anything else (lowercase, separators) doesn't match Claude Code's tool naming and keeps the _warning_ (far more likely a typo).

The catalog records the per-finding severities of `skill/missing-frontmatter` and `skill/dead-tool-restriction` in each rule's `severityVariants`; the rule's `severity` field is the highest it emits.

All v1 rules are marked **experimental** in the catalog -- the heuristics are conservative and may broaden as more skill/agent shapes are observed. Experimental rules bump patch; promotion to stable bumps minor (see `CHANGELOG.md` versioning policy).

---

## 3. Rule Catalog (machine-readable)

A machine-readable JSON catalog of all rules is available at [`agent-skill-lint-rules.json`](./agent-skill-lint-rules.json). It conforms to the shared catalog schema ([`schemas/ctxlint-catalog.schema.json`](./schemas/ctxlint-catalog.schema.json)), like the other three pillars.

Rule IDs use the ctxlint `category/slug` format (see [CONTRIBUTING.md](./CONTRIBUTING.md) "Rule ID format" for why this differs from the sibling mcp-compliance project).

---

## 4. Implementing This Specification

1. Discover skill files (`~/.claude/skills/<name>/SKILL.md`) and agent files (`~/.claude/agents/*.md`). Record each `~/.claude/skills/<name>/` directory that has no `SKILL.md` as an orphaned skill.
2. Parse YAML frontmatter (`name`, `description`, and the tool restrictions: agent `tools` / `disallowedTools`, skill `allowed-tools` / `disallowed-tools`).
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
