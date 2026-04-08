declare const __VERSION__: string | undefined;

// Bundled by tsup/esbuild: __VERSION__ is replaced at build time from package.json.
// Unbundled in vitest: reads package.json at runtime using ESM-compatible imports.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

function loadVersion(): string {
  if (typeof __VERSION__ !== 'undefined') return __VERSION__;
  const __dir = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(__dir, '../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}

export const VERSION: string = loadVersion();
