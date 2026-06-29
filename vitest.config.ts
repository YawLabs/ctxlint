import { defineConfig, configDefaults } from 'vitest/config';

// Windows process spawn is slow, and the git-heavy suites (paths, integration,
// git) run real `git` subprocesses per test. With vitest's default
// fork-per-CPU parallelism this oversubscribes a contended Windows box -- worst
// when `release.sh` runs the full suite locally after lint+build -- and those
// tests blow past even the 30s timeout, the flake that aborted the release.
// Cap fork concurrency on Windows only; Linux CI keeps full parallelism and
// stays the authoritative gate. `forks` (not threads) is required: the git /
// path tests change cwd, which throws in worker threads. Also raise the
// per-test timeout to 60s on Windows: even capped, the git rename-provenance
// tests (real `git log`/rename detection per test) graze the 30s ceiling under
// release.sh's sequential install+lint+build+test load on a slow Windows box.
// 60s gives margin without masking a real hang (a true hang still fails at 60s).
const windowsForkCap =
  process.platform === 'win32'
    ? {
        pool: 'forks' as const,
        poolOptions: { forks: { maxForks: 4, minForks: 1 } },
        testTimeout: 60000,
      }
    : {};

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    ...windowsForkCap,
    // Exclude agent-spawned worktrees -- they shadow our source tree under
    // `.claude/worktrees/` and vitest will otherwise discover and run their
    // copies of the test suite, blowing up duration and producing duplicate
    // (often broken, unbuilt) failures.
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
});
