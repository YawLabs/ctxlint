import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The user's home directory, resolved the way the agents themselves resolve it.
 *
 * Claude Code finds its data through `os.homedir()`, which reads `USERPROFILE`
 * on Windows and `HOME` everywhere else. The env var is consulted directly
 * (rather than calling `os.homedir()` alone) so tests and sandboxes can
 * redirect home by setting it, and `os.homedir()` stays the fallback for a
 * shell that sets neither. The order differs per platform on purpose: Git
 * Bash exports a `HOME` on Windows that need not match `USERPROFILE`, and
 * reading it first would look somewhere Claude Code never writes.
 *
 * Computed per call, never cached at module load: a long-lived process (watch
 * mode, the MCP server) or a test that changes the env must see the change.
 *
 * May return '' in a stripped-down container where nothing resolves; callers
 * must treat that as "no home" rather than joining onto it, which would yield
 * a cwd-relative path.
 */
export function homeDir(): string {
  const env =
    process.platform === 'win32'
      ? process.env.USERPROFILE || process.env.HOME
      : process.env.HOME || process.env.USERPROFILE;
  return env || homedir();
}

/**
 * Claude Code's config directory: `CLAUDE_CONFIG_DIR` when set, else
 * `<home>/.claude`. This is where `projects/`, `history.jsonl`, `skills/`,
 * `agents/` and `settings.json` live.
 *
 * An explicit `home` argument pins the result to `<home>/.claude` and ignores
 * `CLAUDE_CONFIG_DIR`: a caller that names a home (a test fixture, a
 * `--home`-style override) means that home, not whatever the ambient
 * environment points at.
 *
 * Returns '' when no home resolves and `CLAUDE_CONFIG_DIR` is unset.
 */
export function claudeConfigDir(home?: string): string {
  if (home !== undefined) return home ? join(home, '.claude') : '';
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override) return override;
  const h = homeDir();
  return h ? join(h, '.claude') : '';
}

/**
 * Codex CLI's home: `CODEX_HOME` when set, else `<home>/.codex`. Codex reads
 * the same override for its `history.jsonl`.
 */
export function codexHomeDir(): string {
  const override = process.env.CODEX_HOME;
  if (override) return override;
  const h = homeDir();
  return h ? join(h, '.codex') : '';
}
