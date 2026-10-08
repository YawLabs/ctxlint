#!/usr/bin/env node
/**
 * Prove that this machine's oam runs ctxlint's MCP server end to end.
 *
 * check-oam-floor.mjs keeps the floor CONSTANT honest -- consistent across the
 * repo and not behind the latest oam release. Nothing there runs anything.
 * This script is the run: it hosts `bin/ctxlint.mjs serve` through
 * `oam run`, the way Yaw MCP and oam's own sidecar matrix launch it, and
 * completes initialize and tools/list against it with the MCP SDK client.
 * oam's sidecar matrix covers ctxlint too, but only on oam's release cadence,
 * so a ctxlint release could regress on oam between two oam gates; release.sh
 * runs this on ctxlint's cadence. Modelled on Yaw MCP's
 * scripts/verify-oam-floor.mjs.
 *
 * CTXLINT_RUNTIME=oam is set for the child, so the launcher cannot quietly
 * fall back to Node: on an oam at the floor it runs the CLI in-process on that
 * oam, and anything else exits with an error, which is a FAIL here.
 *
 * Outcomes, one line on stdout each, so release.sh can match them:
 *   [verify:oam-floor] OK -- ...     exit 0
 *   [verify:oam-floor] SKIP -- ...   exit 0: no oam on this machine, or
 *                                    CTXLINT_SKIP_OAM_VERIFY=1. Nothing was
 *                                    verified; release.sh warns on it.
 *   [verify:oam-floor] FAIL -- ...   exit 1: an oam below the floor (it cannot
 *                                    vouch for it -- `oam self-update`), a
 *                                    handshake that did not complete, or a
 *                                    tool list that does not match.
 *
 * Which oam: OAM_BIN when set, otherwise the newest of OAM_INSTALL_DIR,
 * %LOCALAPPDATA%\oam\bin (Windows), ~/.oam/bin and PATH -- the launcher's own
 * discovery order. VERIFY_OAM_FLOOR_TIMEOUT_MS bounds each step (default
 * 60000: a cold oam start on a loaded Windows box has been measured past 10 s
 * for `oam --version` alone).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFloor } from './check-oam-floor.mjs';

const TAG = '[verify:oam-floor]';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = join(REPO_ROOT, 'bin', 'ctxlint.mjs');
const TIMEOUT_MS = Number(process.env.VERIFY_OAM_FLOOR_TIMEOUT_MS) || 60_000;

/** Every tool ctxlint serves. A list that differs is a FAIL, not a warning. */
const EXPECTED_TOOLS = [
  'ctxlint_audit',
  'ctxlint_fix',
  'ctxlint_mcp_audit',
  'ctxlint_session_audit',
  'ctxlint_skill_audit',
  'ctxlint_token_report',
  'ctxlint_validate_path',
];

function ok(msg) {
  console.log(`${TAG} OK -- ${msg}`);
  process.exit(0);
}
function skip(msg) {
  console.log(`${TAG} SKIP -- ${msg}`);
  process.exit(0);
}
function fail(msg) {
  console.log(`${TAG} FAIL -- ${msg}`);
  process.exit(1);
}

function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function atLeast(v, min) {
  for (let i = 0; i < 3; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

function versionOf(bin) {
  try {
    return parseVersion(
      execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: TIMEOUT_MS,
        windowsHide: true,
      }),
    );
  } catch {
    return null;
  }
}

function candidates() {
  const exe = process.platform === 'win32' ? 'oam.exe' : 'oam';
  const dirs = [];
  if (process.env.OAM_INSTALL_DIR) dirs.push(process.env.OAM_INSTALL_DIR);
  if (process.platform === 'win32') {
    dirs.push(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'oam', 'bin'));
  }
  dirs.push(join(homedir(), '.oam', 'bin'));
  dirs.push(...(process.env.PATH ?? '').split(delimiter).filter(Boolean));
  const seen = new Set();
  const found = [];
  for (const dir of dirs) {
    const p = join(dir, exe);
    const key = process.platform === 'win32' ? p.toLowerCase() : p;
    if (seen.has(key) || !existsSync(p)) continue;
    seen.add(key);
    found.push(p);
  }
  return found;
}

/** The oam to verify with: OAM_BIN as given, else the newest that answers. */
function chooseOam() {
  if (process.env.OAM_BIN) {
    const version = versionOf(process.env.OAM_BIN);
    if (!version) fail(`OAM_BIN=${process.env.OAM_BIN} did not report a version`);
    return { bin: process.env.OAM_BIN, version };
  }
  let best = null;
  for (const bin of candidates()) {
    const version = versionOf(bin);
    if (version && (!best || !atLeast(best.version, version))) best = { bin, version };
  }
  return best;
}

async function main() {
  if (process.env.CTXLINT_SKIP_OAM_VERIFY === '1') {
    skip('CTXLINT_SKIP_OAM_VERIFY=1 -- the oam handshake was NOT verified for this release');
  }
  if (!existsSync(join(REPO_ROOT, 'dist', 'index.js'))) {
    fail('dist/index.js is missing -- build first (node build.mjs)');
  }

  const floor = readFloor(REPO_ROOT);
  const oam = chooseOam();
  if (!oam) {
    skip(
      `no oam found (OAM_BIN, OAM_INSTALL_DIR, the install dirs, PATH) -- the ${floor.join('.')} floor was NOT verified on this machine`,
    );
  }
  const have = oam.version.join('.');
  if (!atLeast(oam.version, floor)) {
    fail(
      `${oam.bin} is oam ${have}, older than the ${floor.join('.')} floor, so it cannot vouch for it. Run \`oam self-update\`, or point OAM_BIN at a ${floor.join('.')} build.`,
    );
  }

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: oam.bin,
    args: ['run', LAUNCHER, '--', 'serve'],
    env: { ...process.env, CTXLINT_RUNTIME: 'oam' },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: 'ctxlint-verify-oam-floor', version: '1.0.0' });
  const deadline = (what) =>
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${what} did not complete within ${TIMEOUT_MS} ms`)),
        TIMEOUT_MS,
      ).unref(),
    );
  // Settle the verdict first and close the client before reporting it: ok()
  // and fail() exit, and an exit with the server still attached would leave
  // the oam child behind on some platforms.
  let verdict;
  try {
    await Promise.race([client.connect(transport), deadline('initialize')]);
    const info = client.getServerVersion();
    const { tools } = await Promise.race([client.listTools(), deadline('tools/list')]);
    const names = tools.map((t) => t.name).sort();
    if (info?.name !== 'ctxlint') {
      verdict = [fail, `initialize answered as ${JSON.stringify(info)}`];
    } else if (JSON.stringify(names) !== JSON.stringify(EXPECTED_TOOLS)) {
      verdict = [
        fail,
        `tools/list returned [${names.join(', ')}], expected [${EXPECTED_TOOLS.join(', ')}]`,
      ];
    } else {
      verdict = [
        ok,
        `oam ${have} (${oam.bin}) hosted ctxlint ${info.version}: initialize + tools/list (${names.length} tools)`,
      ];
    }
  } catch (err) {
    const tail = stderr.trim().split('\n').slice(-5).join(' | ');
    verdict = [
      fail,
      `${err instanceof Error ? err.message : String(err)}${tail ? ` -- stderr: ${tail}` : ''}`,
    ];
  }
  await client.close().catch(() => {});
  verdict[0](verdict[1]);
}

await main();
