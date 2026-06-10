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
import { relative } from 'node:path';

// Generate-from-catalog drift gate: the spec count headers + README family-table
// counts are DERIVED from the *-rules.json catalogs. The build deliberately does
// NOT rewrite drifted prose in place — it used to, and because the build runs
// before `pnpm run test:run` (release.sh step 2 vs 3, and the `pretest` hooks),
// the silent rewrite fixed the files on disk before the catalog-generate vitest
// --check gate could ever see the drift, leaving regenerated-but-uncommitted
// files behind. Instead: fail loudly and point at the regeneration command, so
// the drift is fixed AND committed by a human/agent before the build proceeds.
{
  const drifted = computeTargets().filter((t) => t.current !== t.generated);
  if (drifted.length > 0) {
    console.error('Catalog-derived prose is out of sync with the rule catalogs:');
    for (const t of drifted) console.error('  ' + relative(process.cwd(), t.file));
    console.error(
      'Run `node scripts/generate-catalog-prose.mjs` (pnpm run generate), review, and commit the result.',
    );
    process.exit(1);
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
