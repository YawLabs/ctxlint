#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/ctxlint.
 *
 * Prefers the oam runtime (https://oamjs.org) and falls back to the Node process
 * already running this file. The CLI itself (`dist/index.js`) is
 * runtime-agnostic -- a pre-bundled ESM entry using only `node:` builtins that
 * oam implements -- so neither path changes behavior. This covers both modes the
 * binary has: the linter (`ctxlint audit ...`) and the MCP server
 * (`ctxlint serve`), since every argument passes through untouched.
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a plain
 * `import()` of the CLI into THIS process: no extra spawn, no extra startup,
 * byte-identical to invoking dist/index.js directly. Discovery is stat-only --
 * never a subprocess -- so the miss case stays sub-millisecond.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first and oam boots second,
 * so the launcher is slower than either runtime alone. It exists so `npx` users
 * get oam automatically. To skip it -- and for `serve`, which an MCP host starts
 * once per session, this is the better config -- point at oam directly:
 *   { "command": "oam", "args": ["run", "<abs>/dist/index.js", "--", "serve"] }
 *
 * NO SANDBOX HERE -- DELIBERATELY
 * oam 0.9.0's `--permission` is real hardening, but it does not fit a linter.
 * ctxlint's whole purpose is to read context files the caller names at run time
 * -- CLAUDE.md, skills, agent transcripts, MCP configs, anywhere on disk -- so a
 * filesystem-read grant would have to be `*` to keep the tool working. Narrowing
 * it would turn "this path is not linted" into a silent clean result, which is
 * the worst failure mode a linter has. What is left to deny (network, child
 * process) it never uses anyway, so the sandbox would gate nothing real.
 *
 * MINIMUM OAM VERSION
 * 0.9.0. Below it `child_process.execFile` ran its arguments through a SHELL,
 * `exec` accepted `timeout` and ignored it, `spawnSync` truncated at `maxBuffer`
 * while reporting success, and `stdio: 'inherit'`/`'ignore'` both behaved as
 * `'pipe'`. This tool spawns nothing in shipped code, so the floor is enforced
 * for consistency across @yawlabs/*-mcp rather than because this launcher was
 * exposed. An older oam is not an error: the launcher falls back to Node and
 * says so on stderr.
 *
 * SELECTION
 *   CTXLINT_RUNTIME=oam     require oam; fail loudly if it is missing
 *   CTXLINT_RUNTIME=node    never use oam
 *   CTXLINT_RUNTIME=auto    prefer oam, silently fall back (default)
 *   OAM_BIN=/path/to/oam    explicit binary, checked before any discovery
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Oldest oam whose `child_process` matches Node. See MINIMUM OAM VERSION above. */
const OAM_MIN = [0, 9, 0];

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Locate an oam binary, or null. Every branch is a stat, never a subprocess. */
function findOam() {
  // 1. Explicit override wins and is never second-guessed.
  const override = process.env.OAM_BIN;
  if (override) return existsSync(override) ? override : null;

  // 2. Installed locations, BEFORE PATH. Someone who develops oam itself usually
  //    has oam/target/release on PATH, and a build directory is the wrong thing
  //    for a user-facing launcher to bind to: cargo replaces the binary
  //    underneath running processes, and the dev build is not the release the
  //    user installed. OAM_BIN remains the way to point at a dev build.
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  for (const candidate of installed) {
    if (existsSync(candidate)) return candidate;
  }

  // 3. PATH, resolved manually rather than by spawning `which`/`where`, which
  //    would cost a subprocess on every launch just to decide whether to spawn.
  const pathExt = isWin ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWin ? pathExt : [""]) {
      const candidate = join(dir, isWin ? `oam${ext.toLowerCase()}` : "oam");
      if (existsSync(candidate)) return candidate;
    }
  }

  return null;
}

/**
 * `oam --version` -> [major, minor, patch], or null when it cannot be read.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(out);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  } catch {
    // Not executable, wrong arch, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/** Run the CLI in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // Point argv[1] at the CLI first, so the in-process path is indistinguishable
  // from having executed the file directly -- an entry-point guard
  // (`import.meta.url === pathToFileURL(process.argv[1]).href`) must read true.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

const mode = (process.env.CTXLINT_RUNTIME ?? "auto").toLowerCase();

if (mode === "node") {
  await runInProcess();
} else {
  const oam = findOam();

  if (!oam) {
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else. writeSync because stderr is async for
      // TTYs/pipes on Windows and process.exit truncates pending writes.
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        "ctxlint: CTXLINT_RUNTIME=oam but no oam binary was found.\n" +
          "Install from https://oamjs.org, set OAM_BIN=/path/to/oam, or use CTXLINT_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    await runInProcess();
  } else if (!atLeast(oamVersion(oam), OAM_MIN)) {
    // Discovery itself stays stat-only; this is the first subprocess, and it
    // runs only once we have already decided to spawn oam anyway. Measured 26ms
    // median (n=12, windows-arm64), paid once per invocation.
    const min = OAM_MIN.join(".");
    if (mode === "oam") {
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        `ctxlint: CTXLINT_RUNTIME=oam but ${oam} is older than oam ${min}.\n` +
          `Run \`oam self-update\`, or use CTXLINT_RUNTIME=node.\n`,
      );
      process.exit(1);
    }
    // auto: an old oam is a reason to prefer Node, not to fail. Say so, because
    // a silent downgrade is how someone keeps running an oam they meant to
    // update. stderr is safe -- MCP frames travel on stdout under `serve`.
    process.stderr.write(`ctxlint: oam at ${oam} is older than ${min}; using Node instead.\n`);
    await runInProcess();
  } else {
    // `--` separates oam's own flags from the script's argv. Everything after it
    // lands in process.argv for the CLI, so `audit`, `serve` and every flag
    // survive the hop unchanged.
    const child = spawn(oam, ["run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout under `serve` is untouched, and the linter's exit-code and
      // output behavior is identical to running it directly.
      stdio: "inherit",
      env: process.env,
      windowsHide: true,
    });

    // If oam cannot be executed at all (deleted between the stat and the spawn,
    // wrong arch, permission), fall back rather than failing outright.
    // `spawned` guards against falling back AFTER the child has begun running.
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (err) => {
      if (spawned) return;
      if (mode === "oam") {
        process.stderr.write(`ctxlint: failed to launch oam (${err.message})\n`);
        process.exit(1);
      }
      void runInProcess();
    });

    // Forward termination so the CLI's own shutdown path runs in the child
    // rather than the child being orphaned. Signals are a no-op on Windows but
    // harmless to register.
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        if (!child.killed) child.kill(sig);
      });
    }

    child.on("exit", (code, signal) => {
      // Mirror the child's fate: a signal death becomes 128+n so callers see a
      // conventional shell exit status rather than a bare 0. ctxlint's exit code
      // is how CI reads a lint failure, so passing it through is load-bearing.
      if (signal) {
        process.exit(128 + (constants.signals[signal] ?? 15));
      }
      process.exit(code ?? 0);
    });
  }
}
