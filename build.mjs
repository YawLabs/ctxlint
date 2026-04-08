/**
 * Bundles ctxlint into a single self-contained file with zero runtime dependencies.
 *
 * Why: `npx` has to install all runtime dependencies on every cold start.
 * With ~80 MB of node_modules (MCP SDK + zod + chalk + simple-git + etc.),
 * this takes minutes on Windows. By bundling everything into one file and
 * declaring zero runtime dependencies, npx downloads only the tarball
 * and runs immediately.
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

// Some bundled deps (commander, simple-git) are CJS and use require() for
// Node built-ins. ESM output needs a createRequire shim so those calls work.
const requireShim = `
import { createRequire as __createRequire } from 'node:module';
const require = __createRequire(import.meta.url);
`;

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/index.js',
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  banner: {
    js: `#!/usr/bin/env node\n${requireShim}`,
  },
  // Node built-ins are provided by the runtime, not bundled
  external: ['node:*'],
  sourcemap: true,
  // Keep readable for debugging
  minify: false,
});
