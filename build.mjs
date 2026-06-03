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
import { computeTargets } from './scripts/generate-catalog-prose.mjs';
import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';

// Generate-from-catalog: regenerate the spec count headers + README family-table
// counts FROM the *-rules.json catalogs before bundling, so the checked-in prose
// can never drift from the machine-readable source of truth. The catalog-generate
// vitest test runs the same script in --check mode (see
// scripts/generate-catalog-prose.mjs) and fails if a count was hand-edited without
// regen; that test runs in release.sh via `pnpm run test:run`.
for (const t of computeTargets()) {
  if (t.current !== t.generated) {
    writeFileSync(t.file, t.generated, 'utf-8');
    console.log('regenerated ' + relative(process.cwd(), t.file));
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

// Path classifier's web-first-segment list lives in tests/fixtures so additions
// go through a fixture edit + a test, not a code edit. Bundled in here so the
// dist doesn't need the tests/ tree at runtime.
const webFirstSegments = JSON.parse(
  readFileSync('tests/fixtures/web-first-segments.json', 'utf-8'),
);
const webFirstSegmentsList = Array.isArray(webFirstSegments)
  ? webFirstSegments
  : webFirstSegments.segments;

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
    __WEB_FIRST_SEGMENTS__: JSON.stringify(webFirstSegmentsList),
  },
  banner: {
    js: `#!/usr/bin/env node\n${requireShim}`,
  },
  // Node built-ins are provided by the runtime, not bundled
  external: ['node:*'],
  // Prefer ESM entry points when present (jsonc-parser ships UMD as `main`,
  // which uses extensionless require() that breaks inside an ESM bundle).
  mainFields: ['module', 'main'],
  sourcemap: true,
  // Keep readable for debugging
  minify: false,
});
