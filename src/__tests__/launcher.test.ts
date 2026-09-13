import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '../..');
const LAUNCHER = path.resolve(REPO_ROOT, 'bin/ctxlint.mjs');
const CLI = path.resolve(REPO_ROOT, 'dist/index.js');
const PKG = JSON.parse(fs.readFileSync(path.resolve(REPO_ROOT, 'package.json'), 'utf-8'));

type Plan = 'in-process' | 'discover';
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined }) => Plan;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the CLI -- which lints the importer's
 * argv and cwd and calls process.exit (see entry.test.ts) -- so importing it
 * from a test would run ctxlint inside the test worker. Making it importable
 * would mean gating that body behind an entry-point check -- a behaviour change
 * to a shipped runtime artifact whose failure mode (the guard reads false under
 * an npm shim, and the launcher silently does nothing) is worse than the gap
 * this closes. This is the same idiom tailscale-mcp's launcher test uses.
 *
 * Extracting the text exercises the shipped logic rather than a copy that can
 * drift, and a failed extraction is a loud assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const source = fs.readFileSync(LAUNCHER, 'utf-8');
  const pieces = [
    /const OAM_MIN = \[[^\]]*\];/,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    /function atLeast\(v, min\) \{[\s\S]*?\n\}/,
    /function runtimePlan\(\{ mode, hostOam \}\) \{[\s\S]*?\n\}/,
  ].map((pattern) => {
    const match = source.match(pattern);
    if (!match) {
      throw new Error(
        `could not extract ${pattern} from bin/ctxlint.mjs -- renamed or reformatted?`,
      );
    }
    return match[0];
  });
  return new Function(`${pieces.join('\n')}\nreturn runtimePlan;`)() as RuntimePlan;
}

describe('launcher runtimePlan()', () => {
  const runtimePlan = loadRuntimePlan();

  it('runs in-process when already hosted on an oam at or above the floor', () => {
    // The bug this exists for: a host that launches `oam run bin/ctxlint.mjs`
    // got a SECOND oam, because the launcher discovered and spawned one without
    // asking what it was already running on. `auto` and `oam` both have to take
    // the shortcut -- `oam` demands oam, and the host already is one.
    //
    // 0.9.0 pins the floor as inclusive (it IS the supported release), and
    // 0.10.0 pins a numeric compare: it sorts BEFORE 0.9.0 as a string, so a
    // compare over the raw text would spawn a nested oam on every 0.10+ host.
    for (const mode of ['auto', 'oam']) {
      for (const hostOam of ['0.9.0', '0.10.0', '0.15.1', '1.0.0', '0.16.0-dev']) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe(
          'in-process',
        );
      }
    }
  });

  it('leaves a host oam below the floor on the discovery path', () => {
    // Same floor as a discovered binary. Below it, behaviour is exactly what it
    // was before the shortcut existed.
    for (const mode of ['auto', 'oam']) {
      for (const hostOam of ['0.8.9', '0.8.2', '0.0.1']) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe('discover');
      }
    }
  });

  it('discovers as before on Node, where process.versions has no oam key', () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ['auto', 'oam']) {
      for (const hostOam of [undefined, '', 'dev']) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe('discover');
      }
    }
  });

  it('runs CTXLINT_RUNTIME=node in-process whatever the host is', () => {
    for (const hostOam of [undefined, '0.8.2', '0.15.1']) {
      expect(runtimePlan({ mode: 'node', hostOam }), `hostOam=${hostOam}`).toBe('in-process');
    }
  });
});

type LauncherRun = { stdout: string; stderr: string; code: number | null };

/**
 * Run the REAL bin under Node, optionally posing as oam by preloading a
 * `process.versions.oam` key, and return what it wrote.
 *
 * The unit tests above prove the decision; these prove the launcher WIRES it
 * -- that the call site actually reads `process.versions.oam` -- which no
 * amount of testing `runtimePlan` in isolation can. A real oam cannot be
 * assumed on every box this suite runs on, and the preload changes exactly the
 * one fact the launcher branches on.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam. In-process, `--version` reaches
 * dist/index.js and prints the package version with exit 0. On the discovery
 * path, findOam returns that pinned Node, `node --version` clears the floor,
 * and the launcher spawns `node run <entry> -- --version` -- which has no `run`
 * subcommand, prints no version and exits non-zero. It also keeps a real oam
 * installed on the developer's box out of reach, since findOam checks the
 * override first and never scans past it.
 *
 * Env is a whitelist so a CTXLINT_* var exported by the developer's shell
 * cannot change what is being asserted.
 */
function runLauncher(
  hostOam: string | undefined,
  extraEnv: Record<string, string> = {},
): Promise<LauncherRun> {
  const preload =
    hostOam === undefined
      ? []
      : [
          '--import',
          `data:text/javascript,${encodeURIComponent(
            `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`,
          )}`,
        ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preload, LAUNCHER, '--version'], {
      env: { PATH: process.env.PATH ?? '', OAM_BIN: process.execPath, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', reject);
    // `close` rather than `exit`, so both pipes have drained before asserting.
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

describe('launcher on an oam host', () => {
  // The in-process path imports dist/index.js, so these need a build. Skip
  // rather than fail when a developer runs `vitest` directly without one;
  // `pnpm test` and `pnpm run test:run` always build first (pretest).
  const buildAvailable = fs.existsSync(CLI);
  // Each case boots one to three Node processes (launcher, `--version` probe,
  // spawned child). 60s matches vitest.config.ts's Windows testTimeout, where
  // a single `node` spawn on a contended box was measured well past 15s.
  const TIMEOUT_MS = 60_000;

  const ranInProcess = (run: LauncherRun) => run.code === 0 && run.stdout.trim() === PKG.version;

  // A spawned child failing, not the launcher diagnosing: every launcher
  // message starts with `ctxlint: `. Without this, a launcher that fell back
  // to Node with a warning and then crashed would pass for a spawn.
  const expectSpawned = (run: LauncherRun, why: string) => {
    expect(ranInProcess(run), `${why}, got ${JSON.stringify(run)}`).toBe(false);
    expect(run.code).not.toBe(0);
    expect(run.stderr).not.toMatch(/^ctxlint: /m);
  };

  it.skipIf(!buildAvailable)(
    'control: on plain Node the launcher still discovers and spawns',
    async () => {
      // Without this, the in-process cases below would also pass for a launcher
      // that ALWAYS runs in-process and never uses oam at all.
      expectSpawned(await runLauncher(undefined), 'expected a spawn');
    },
    TIMEOUT_MS,
  );

  const onOamEnvs: Record<string, string>[] = [{}, { CTXLINT_RUNTIME: 'oam' }];
  for (const extraEnv of onOamEnvs) {
    it.skipIf(!buildAvailable)(
      `runs in-process instead of spawning a nested oam (env ${JSON.stringify(extraEnv)})`,
      async () => {
        const run = await runLauncher('0.15.1', extraEnv);
        expect(ranInProcess(run), JSON.stringify(run)).toBe(true);
      },
      TIMEOUT_MS,
    );
  }

  it.skipIf(!buildAvailable)(
    'still discovers when the host oam is below the floor',
    async () => {
      expectSpawned(await runLauncher('0.8.9'), 'a below-floor host must not shortcut');
    },
    TIMEOUT_MS,
  );
});
