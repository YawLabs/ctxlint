# Contributing

Thanks for your interest in contributing! This guide covers the workflow for both human contributors and AI coding agents.

## Quick Start

```bash
# 1. Fork this repo on GitHub, then clone your fork
git clone https://github.com/<your-username>/<repo-name>.git
cd <repo-name>

# 2. Install dependencies
npm install

# 3. Create a branch
git checkout -b your-branch-name

# 4. Make your changes, then verify everything passes
npm run format && npm run lint
npm run build
npm test
```

## Submitting a Pull Request

1. **One PR per change.** Keep PRs focused — a bug fix, a new feature, or a refactor, not all three.
2. **Branch from `main`** (or `master` if that's the default branch).
3. **Run `npm run format && npm run lint`** before committing — CI will reject formatting issues.
4. **Run `npm test`** and confirm all tests pass.
5. **Write a clear PR title and description** — explain *what* changed and *why*.
6. **All PRs require approval** from a maintainer before merging.

## Development Workflow

| Command | What it does |
|---------|-------------|
| `npm install` | Install dependencies |
| `npm run build` | Bundle `src/` → `dist/index.js` via esbuild |
| `npm run dev` | Same as `build` — one-shot rebuild |
| `npm test` | Run the test suite (vitest, watch mode) |
| `npm run test:run` | Run the test suite once (no watch) |
| `npm run test:coverage` | Run tests with v8 coverage report |
| `npm run lint` | Check for ESLint errors |
| `npm run format` | Auto-format via Prettier |

## Code Style

- TypeScript, strict mode
- Formatting and linting are enforced by Prettier + ESLint — run `npm run format && npm run lint` and let the tooling handle it
- No unnecessary abstractions — keep code simple and direct
- Add tests for new functionality

## For AI Coding Agents

If you're an AI agent (Claude Code, Copilot, Cursor, etc.) submitting a PR:

1. **Fork the repo** and work on a branch — direct pushes to the default branch are blocked.
2. **Always run `npm run format && npm run lint && npm run build && npm test`** before committing. Do not skip this.
3. **Do not add unrelated changes** — no drive-by refactors, no extra comments, no unrelated formatting fixes.
4. **PR description must explain the change clearly** — what problem does it solve, how does it work, how was it tested.
5. **One logical change per PR.** If you're fixing a bug and adding a feature, that's two PRs.

## Writing a new check

A "check" is a single lint category (e.g., `paths`, `tokens`, `tier-tokens`). Each check lives in its own file under `src/core/checks/` and can emit one or more **rules** — specific issue variants identified by `ruleId` like `paths/not-found` or `tier-tokens/section-breakdown`. Here's the end-to-end recipe.

### 1. Pick a check name and rule IDs

- Check name: short, kebab-case, matches the directory it'd live in (e.g., `staleness`, `ci-coverage`).
- Rule IDs: `<check>/<specific-thing>` (e.g., `tier-tokens/aggregate`).
- If the matching logic is heuristic or likely to evolve, mark rules `"stability": "experimental"` in the catalog. Experimental rules bump patch; stable rules bump minor (see `CHANGELOG.md` → Versioning policy).

### 2. Create the check file

`src/core/checks/<name>.ts`:

```ts
import type { ParsedContextFile, LintIssue } from '../types.js';

export async function checkYourName(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];
  // Detection logic here.
  issues.push({
    severity: 'warning',             // 'error' | 'warning' | 'info'
    check: 'your-name',
    ruleId: 'your-name/specific-thing',
    line: 1,                         // 1-indexed source line
    message: 'human-readable',
    suggestion: 'what to do instead',
    detail: 'optional extra context',
  });
  return issues;
}
```

Cross-file checks (run once across all parsed files) take `files: ParsedContextFile[]` and return `LintIssue[]`. See `src/core/checks/contradictions.ts` for an example.

### 3. Wire into the type system and audit

Edit **`src/core/types.ts`**:

```ts
export type CheckName =
  | 'paths'
  | ...existing...
  | 'your-name';           // add here
```

Edit **`src/core/audit.ts`**:

```ts
import { checkYourName } from './checks/your-name.js';

export const ALL_CHECKS: CheckName[] = [
  ...existing,
  'your-name',             // add here so it runs by default
];

// inside runAudit's per-file loop:
if (activeChecks.includes('your-name'))
  checkPromises.push(checkYourName(file, projectRoot));
```

For cross-file or session/MCP checks, use the corresponding cross-file block or the `ALL_SESSION_CHECKS` / `ALL_MCP_CHECKS` array.

### 4. Add to the rule catalog

Edit **`context-lint-rules.json`** (or `agent-session-lint-rules.json` / `mcp-config-lint-rules.json` depending on the check's domain):

```json
{
  "id": "your-name/specific-thing",
  "category": "your-name",
  "severity": "warning",
  "description": "What this rule catches and why.",
  "trigger": "The exact condition that fires the rule.",
  "message": "Template with {placeholders}.",
  "fixable": false,
  "stability": "stable"
}
```

Also add a category entry at the top of the same file if you introduced a new check name. The catalog is consumed by downstream integrations — keep it accurate.

### 5. Write tests

- **Unit test** at `src/core/checks/__tests__/<name>.test.ts` — feed in a fabricated `ParsedContextFile` and assert on the emitted issues. Do not read real files unless you must; use a `tmpDir` fixture when you do.
- **Integration test** in `src/core/__tests__/integration.test.ts` — drive the CLI against a fixture and assert the rule fires (or doesn't, for negative cases).
- Add a **fixture** under `fixtures/<scenario>/` if your check needs a real project shape (`package.json`, context files, etc.).
- Run `npm run test:coverage` — new check files should land above 90% line coverage.

### 6. Ship it

- `npm run format && npm run lint && npm run build && npm run test:run` — confirm everything is green before committing.
- The commit message should call out the new rule IDs and whether they're stable or experimental.
- New **stable** check → minor bump; new **experimental** check → patch bump. Per the versioning policy in `CHANGELOG.md`.

## Reporting Issues

Open an issue on GitHub. Include:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Environment details (OS, Node version, etc.)

## License

By contributing, you agree that your contributions will be licensed under the same license as this project.
