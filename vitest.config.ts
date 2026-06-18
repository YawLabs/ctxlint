import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    // Exclude agent-spawned worktrees -- they shadow our source tree under
    // `.claude/worktrees/` and vitest will otherwise discover and run their
    // copies of the test suite, blowing up duration and producing duplicate
    // (often broken, unbuilt) failures.
    exclude: [...configDefaults.exclude, '.claude/worktrees/**'],
  },
});
