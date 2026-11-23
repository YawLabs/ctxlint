/**
 * Every oam binary the launcher's discovery can see, for the repo scripts.
 *
 * A port of discoverOamPaths in bin/ctxlint.mjs, which cannot be imported: the
 * launcher resolves a runtime and runs the CLI when its module body runs, and
 * it must stay self-contained because it ships while scripts/ does not.
 * verify-oam-floor.mjs used to carry a third copy whose de-duplication folded
 * case but did not resolve links, so a symlinked oam reached twice was probed
 * twice. src/__tests__/launcher.test.ts runs this and the launcher's own
 * function over the same directories and fails when they disagree.
 *
 * Order: OAM_INSTALL_DIR, %LOCALAPPDATA%\oam\bin (Windows), ~/.oam/bin, then
 * PATH. Windows takes oam.exe only -- Node cannot spawn a .cmd/.bat without a
 * shell. Paths are de-duplicated by their resolved, case-folded (Windows)
 * identity, keeping the first spelling.
 */

import { existsSync, realpathSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';

export function discoverOamPaths({
  env = process.env,
  platform = process.platform,
  homedir = osHomedir(),
} = {}) {
  const isWin = platform === 'win32';
  const { join, delimiter } = isWin ? path.win32 : path.posix;
  const exe = isWin ? 'oam.exe' : 'oam';
  const pathKey = (p) => {
    let key = p;
    try {
      key = realpathSync(p);
    } catch {
      // Unresolvable: fall back to the literal path.
    }
    return isWin ? key.toLowerCase() : key;
  };
  const installed = [join(homedir, '.oam', 'bin', exe)];
  if (isWin) {
    installed.unshift(
      join(env.LOCALAPPDATA ?? join(homedir, 'AppData', 'Local'), 'oam', 'bin', exe),
    );
  }
  if (env.OAM_INSTALL_DIR) installed.unshift(join(env.OAM_INSTALL_DIR, exe));
  const onPath = (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}
