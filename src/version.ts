declare const __VERSION__: string | undefined;

// Bundled by tsup: __VERSION__ is replaced at build time from package.json.
// Unbundled in vitest: reads package.json at runtime.
/* eslint-disable @typescript-eslint/no-require-imports */
function loadVersion(): string {
  if (typeof __VERSION__ !== 'undefined') return __VERSION__;
  const fs = require('fs');
  const path = require('path');
  const pkgPath = path.resolve(__dirname, '../package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return pkg.version;
}
/* eslint-enable @typescript-eslint/no-require-imports */

export const VERSION: string = loadVersion();
