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
  // Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
  // run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and
  // for spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking
  // the full PATHEXT list would hand back a path this launcher cannot execute.
  // Discovery has to agree with execution. A skipped shim is still reported --
  // see findOamShim.
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
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

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Reported rather than ignored, because "no oam binary was found"
 * reads as "install oam" -- the one thing that will not help. Windows only;
 * there is no such shim concept on POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
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
  // Read the version ONCE, and only when discovery found something: the
  // gate below has to tell "too old" apart from "could not be read at all",
  // and re-probing inside the branch would cost a second subprocess.
  const found = oam ? oamVersion(oam) : null;

  if (!oam) {
    // An oam-named .cmd/.bat on PATH is a real install in a shape this
    // launcher cannot spawn. Naming it turns "no oam binary was found" --
    // which reads as "install oam", the one thing that will not help --
    // into something the user can act on.
    const oamShim = findOamShim();
    const shimNote = oamShim
      ? `Found ${oamShim}, but Node cannot execute a .cmd/.bat directly.\n` +
        "Install the native oam binary, or point OAM_BIN at one.\n"
      : "";
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration -- do not
      // silently do something else. writeSync because stderr is async for
      // TTYs/pipes on Windows and process.exit truncates pending writes.
      const { writeSync } = await import("node:fs");
      writeSync(
        2,
        "ctxlint: CTXLINT_RUNTIME=oam but no runnable oam binary was found.\n" + shimNote +
          "Install from https://oamjs.org, set OAM_BIN=/path/to/oam, or use CTXLINT_RUNTIME=node.\n",
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their oam install is a shape this launcher skips.
    if (oamShim) await errSync(`ctxlint: ${shimNote}Using Node instead.\n`);
    await runInProcess();
  } else if (!atLeast(found, OAM_MIN)) {
    const min = OAM_MIN.join(".");
    // Two different causes reach this branch and they need different
    // remedies. `found === null` is NOT "old": oamVersion returns null when
    // the binary could not be run at all (not executable, wrong arch, a
    // .cmd/.bat Node refuses, deleted between the stat and the probe) or
    // when its --version output did not parse. Telling that user to
    // `oam self-update` sends them after the one cause it definitely is not.
    const detail = found
      ? `${oam} is oam ${found.join(".")}, older than ${min}`
      : `${oam} could not be run, or did not report a version this launcher understands`;
    const remedy = found
      ? "Run \`oam self-update\`, or use CTXLINT_RUNTIME=node.\n"
      : "Check that it is an executable oam binary for this platform, or use CTXLINT_RUNTIME=node.\n";
    if (mode === "oam") {
      await errSync(`ctxlint: CTXLINT_RUNTIME=oam but ${detail}.\n${remedy}`);
      process.exit(1);
    }
    // auto: neither cause is worth failing over -- prefer Node. Say so,
    // because a silent downgrade is how someone keeps running an oam they
    // meant to update, or never learns their oam is unexecutable.
    await errSync(`ctxlint: ${detail}; using Node instead.\n`);
    await runInProcess();
  } else {
    // `--` separates oam's own flags from the script's argv. Everything after it
    // lands in process.argv for the CLI, so `audit`, `serve` and every flag
    // survive the hop unchanged.
    // Every "oam could not be executed" outcome lands here: the synchronous
    // throw from spawn() and the async 'error' event mean the same thing and
    // must degrade the same way, so the handling lives in one place.
    // errSync rather than process.stderr.write because stderr is async for
    // TTYs and pipes on Windows and the process.exit below truncates pending
    // writes.
    const launchFailed = async (err) => {
      if (mode === "oam") {
        await errSync(`ctxlint: failed to launch oam (${err?.message ?? err})\n`);
        process.exit(1);
      }
      await runInProcess();
    };

    // ONE reporter shared by both launchFailed call sites, so the sync-throw
    // path and the 'error'-event path cannot drift apart. Either can reject:
    // runInProcess() is a bare import() that rejects when dist/index.js is
    // missing, and at ESM top level an unhandled rejection is an uncaught
    // exception -- the exact failure this handling exists to prevent.
    const fallbackFailed = (e) => {
      process.stderr.write(`ctxlint: fallback to Node failed (${e?.message ?? e})\n`);
      process.exitCode = 1;
    };

    let child = null;
    try {
      child = spawn(oam, ["run", SERVER_ENTRY, "--", ...process.argv.slice(2)], {
        // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
        // stdin/stdout under `serve` is untouched, and the linter's exit-code and
        // output behavior is identical to running it directly.
        stdio: "inherit",
        env: process.env,
        windowsHide: true,
      });
    } catch (err) {
      // spawn() THROWS for some failures instead of emitting 'error', and the
      // 'error' listener is registered AFTER this call, so it can never observe
      // one -- an uncaught throw here kills the launcher with a raw stack trace
      // instead of falling back to Node.
      await launchFailed(err).catch(fallbackFailed);
    }

    if (child) {

      // If oam cannot be executed at all (deleted between the stat and the spawn,
      // wrong arch, permission), fall back rather than failing outright.
      // `spawned` guards against falling back AFTER the child has begun running.
      let spawned = false;
      child.on("spawn", () => {
        spawned = true;
      });
      child.on("error", (err) => {
        if (spawned) return;
        // Handle the rejection instead of discarding it: a failing in-process
        // fallback would otherwise escape as an unhandled rejection, replacing
        // this launcher's diagnostic with a raw stack trace.
        launchFailed(err).catch(fallbackFailed);
      });

      // Forward termination so the server's own shutdown path runs in the child
      // rather than the child being orphaned.
      //
      // Registering ANY handler for these suppresses Node's default
      // terminate-on-signal, so the parent's exit has to be arranged explicitly.
      // `child.killed` only records that kill() was CALLED, never that the child
      // is gone, so gating on it swallows every signal after the first and wedges
      // the launcher with no escape hatch.
      //
      // Escalation is driven by a TIMER, not by counting signals. Counting is
      // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
      // apart, and a terminal Ctrl-C reaches the whole process group, so reading
      // "a second signal" as impatience hard-kills a child that is already
      // shutting down cleanly. A timer makes the count irrelevant -- ONE press is
      // enough, and a wedged child dies on schedule. setTimeout is monotonic, so
      // a wall-clock step cannot mis-gate the window either.
      //
      // POSIX vs Windows, and why we do NOT forward on Windows.
      // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
      // is what lets the child run its shutdown. On Windows there are no POSIX
      // signals: child.kill IGNORES the name and calls TerminateProcess -- an
      // immediate hard kill (verified: a child with a SIGTERM handler never runs
      // it and dies with code=null, signal=SIGTERM). Forwarding there ABORTS the
      // graceful shutdown the console's own Ctrl-C just started, skipping the
      // child's process.on("exit") cleanup. The console has already notified the
      // child, so on Windows the timer below is the only kill we issue.
      const ESCALATE_AFTER_MS = 2000;
      let escalation = null;
      for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, () => {
          // No try/catch: kill() on an already-exited child returns false, it does
          // not throw. It throws only for a signal the platform does not know,
          // which SIGINT/SIGTERM/SIGKILL never are.
          if (!isWin) child.kill(sig);
          if (escalation) return; // already counting down; further signals are noise
          escalation = setTimeout(() => {
            // Still here after its grace window. Stop waiting on it.
            child.kill("SIGKILL");
            process.exit(128 + (constants.signals[sig] ?? 15));
          }, ESCALATE_AFTER_MS);
        });
      }

      child.on("exit", (code, signal) => {
        if (escalation) clearTimeout(escalation);
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
}
