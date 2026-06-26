declare const __VERSION__: string | undefined;

// Bundled by tsup/esbuild: __VERSION__ is replaced at build time from package.json.
// Unbundled in vitest: reads package.json at runtime using ESM-compatible imports.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadVersion(): string {
  if (typeof __VERSION__ !== 'undefined') return __VERSION__;
  // Unbundled (vitest / source-run) path only: a missing or malformed
  // package.json must not crash the CLI at module-load time -- this runs before
  // commander or any try/catch is set up, so an unguarded throw here takes down
  // `--version`/`--help` too. Degrade to a sentinel instead. The published build
  // inlines __VERSION__, so this fallback never runs in production.
  try {
    const __dir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = resolve(__dir, '../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export const VERSION: string = loadVersion();
