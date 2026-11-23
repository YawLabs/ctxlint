/**
 * "Was this module run directly?" for the repo scripts, in one place.
 *
 * Each script used to carry its own answer, and one of them was the bug this
 * exists to prevent: Node realpaths the main module's URL (unless
 * --preserve-symlinks-main) but leaves argv[1] as typed, so from a junctioned
 * or symlinked checkout a raw compare of the two is false -- main() is skipped
 * and the script exits 0 in silence, a silence that reads as a pass.
 */

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when `argv1` (process.argv[1]) names the module at `moduleUrl`. Both
 * sides are realpath'd, so the answer holds with or without
 * --preserve-symlinks-main; a path that cannot be resolved is compared as
 * given.
 */
export function isMainModule(argv1, moduleUrl) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return real(argv1) === real(fileURLToPath(moduleUrl));
}
