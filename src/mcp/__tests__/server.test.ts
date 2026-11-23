import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION } from '../../version.js';
import { auditText, MAX_AUDIT_TEXT_BYTES } from '../server.js';
import type { LintResult } from '../../core/types.js';

const SERVER_JS = path.resolve(__dirname, '../../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../../fixtures');
const SRC = path.resolve(__dirname, '../..');

/** Newest mtime of a non-test source file under `dir`. */
function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') newest = Math.max(newest, newestSourceMtime(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      newest = Math.max(newest, fs.statSync(full).mtimeMs);
    }
  }
  return newest;
}

// These tests spawn the BUILT server. A missing or stale dist/index.js would
// test old code (or fail every test with an opaque spawn error), so say so up
// front instead.
beforeAll(() => {
  if (!fs.existsSync(SERVER_JS)) {
    throw new Error(`${SERVER_JS} is missing: run \`node build.mjs\` before these tests`);
  }
  if (fs.statSync(SERVER_JS).mtimeMs < newestSourceMtime(SRC)) {
    throw new Error(
      `${SERVER_JS} is older than src/: run \`node build.mjs\` so these tests exercise the current code`,
    );
  }
});

/**
 * Helper to call an MCP tool by sending a JSON-RPC request over stdin.
 * We use a short-lived process since the MCP server runs on stdio.
 */
function callMcpTool(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  // Build the JSON-RPC initialize + call sequence
  const initRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  });

  const callRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });

  const input = initRequest + '\n' + callRequest + '\n';

  try {
    const stdout = execFileSync('node', [SERVER_JS, '--mcp-server'], {
      input,
      encoding: 'utf-8',
      // 60s to match vitest.config.ts's Windows testTimeout. This inner
      // ceiling was left at 15s when that was raised, so a real `node`
      // spawn on a contended Windows box was killed at 15s and surfaced
      // as ETIMEDOUT / exitCode 1 -- a load artifact indistinguishable
      // from a genuine failure. The outer testTimeout still catches a
      // true hang.
      timeout: 60000,
    });

    // Parse the last JSON-RPC response (the tool call result)
    const lines = stdout.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.id === 2 && parsed.result) {
          const text = parsed.result.content?.[0]?.text;
          if (text) return JSON.parse(text);
        }
      } catch {
        continue;
      }
    }
    throw new Error('No valid response found');
  } catch (err: any) {
    // Process exits because stdin closes — that's expected
    // Parse whatever output we got
    const output = err.stdout || '';
    const lines = output.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed.id === 2 && parsed.result) {
          const text = parsed.result.content?.[0]?.text;
          if (text) return JSON.parse(text);
        }
      } catch {
        continue;
      }
    }
    throw new Error(`MCP tool call failed: ${err.message}`, { cause: err });
  }
}

/** List registered tool names via a JSON-RPC tools/list request. */
function listMcpTools(): string[] {
  const initRequest = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' },
    },
  });
  const listRequest = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const input = initRequest + '\n' + listRequest + '\n';

  let stdout: string;
  try {
    stdout = execFileSync('node', [SERVER_JS, '--mcp-server'], {
      input,
      encoding: 'utf-8',
      timeout: 60000,
    });
  } catch (err: any) {
    // Process exits when stdin closes — parse whatever output we got
    stdout = err.stdout || '';
  }
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed.id === 2 && parsed.result?.tools) {
        return parsed.result.tools.map((t: { name: string }) => t.name);
      }
    } catch {
      continue;
    }
  }
  throw new Error('No tools/list response found');
}

describe('MCP server tools', () => {
  describe('tool registration', () => {
    it('exposes all four lint pillars plus the utility tools', () => {
      const names = listMcpTools();
      expect(names).toContain('ctxlint_audit');
      expect(names).toContain('ctxlint_validate_path');
      expect(names).toContain('ctxlint_token_report');
      expect(names).toContain('ctxlint_fix');
      expect(names).toContain('ctxlint_mcp_audit');
      expect(names).toContain('ctxlint_session_audit');
      expect(names).toContain('ctxlint_skill_audit');
    });
  });

  describe('ctxlint_audit', () => {
    it('returns audit results for a project with context files', () => {
      const result = callMcpTool('ctxlint_audit', {
        projectPath: path.join(FIXTURES, 'broken-paths'),
        checks: ['paths'],
      });
      expect(result.version).toBe(VERSION);
      expect(result.files).toBeDefined();
      expect((result as any).summary.errors).toBeGreaterThan(0);
    });

    it('returns empty results for project with no issues', () => {
      const result = callMcpTool('ctxlint_audit', {
        projectPath: path.join(FIXTURES, 'healthy-project'),
        checks: ['paths', 'commands'],
      });
      expect(result.version).toBe(VERSION);
      expect((result as any).summary.errors).toBe(0);
    });

    it('filters by check type', () => {
      const result = callMcpTool('ctxlint_audit', {
        projectPath: path.join(FIXTURES, 'broken-paths'),
        checks: ['tokens'],
      }) as any;
      const allChecks = result.files.flatMap((f: any) => f.issues.map((i: any) => i.check));
      expect(allChecks.every((c: string) => c === 'tokens')).toBe(true);
    });
  });

  describe('ctxlint_validate_path', () => {
    it('returns exists: true for valid path', () => {
      const result = callMcpTool('ctxlint_validate_path', {
        path: 'src/app.ts',
        projectPath: path.join(FIXTURES, 'broken-paths'),
      });
      expect(result.exists).toBe(true);
    });

    it('returns exists: false for invalid path', () => {
      const result = callMcpTool('ctxlint_validate_path', {
        path: 'src/nonexistent.ts',
        projectPath: path.join(FIXTURES, 'broken-paths'),
      });
      expect(result.exists).toBe(false);
    });

    it('rejects a path-traversal attempt with isError', () => {
      // Path-traversal guard: `../../../etc/passwd` resolves outside the
      // project root, so the tool must refuse rather than `fs.stat` it.
      const result = callMcpTool('ctxlint_validate_path', {
        path: '../../../etc/passwd',
        projectPath: path.join(FIXTURES, 'broken-paths'),
      }) as any;
      expect(result.error).toBeDefined();
      expect(String(result.error)).toMatch(/escape/i);
    });

    it('rejects a deeper path-traversal attempt (../../../../etc/passwd)', () => {
      // Lock in the defence-in-depth contract for a 4-level traversal alongside
      // the 3-level case above -- resolveWithinRoot must still refuse.
      const result = callMcpTool('ctxlint_validate_path', {
        path: '../../../../etc/passwd',
        projectPath: path.join(FIXTURES, 'broken-paths'),
      }) as any;
      expect(result.error).toBeDefined();
      expect(String(result.error)).toMatch(/escape/i);
    });

    it('accepts a legitimate nested relative path', () => {
      // Sanity check that the traversal guard doesn't block normal paths
      // that happen to contain segments resolvable inside the root.
      const result = callMcpTool('ctxlint_validate_path', {
        path: './src/app.ts',
        projectPath: path.join(FIXTURES, 'broken-paths'),
      });
      expect(result.exists).toBe(true);
    });

    // findRenames' default coordinates are git repo-root-relative, so with a
    // projectPath that is a repo SUBDIRECTORY the suggested newPath carried
    // the subdirectory prefix (`pkg/src/new.ts`) and did not resolve against
    // the project root the caller passed.
    it('reports a rename target relative to a subdirectory project root', () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-mcp-rename-'));
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          [
            '-c',
            'user.email=t@example.com',
            '-c',
            'user.name=t',
            '-c',
            'core.autocrlf=false',
            ...args,
          ],
          { cwd: repo, stdio: 'pipe' },
        );
      try {
        try {
          git('init', '-q');
        } catch {
          return; // git unavailable
        }
        fs.mkdirSync(path.join(repo, 'pkg', 'src'), { recursive: true });
        fs.writeFileSync(path.join(repo, 'pkg', 'src', 'old.ts'), 'export const x = 1;\n');
        git('add', '.');
        git('commit', '-q', '-m', 'add');
        git('mv', 'pkg/src/old.ts', 'pkg/src/new.ts');
        git('commit', '-q', '-m', 'rename');

        const result = callMcpTool('ctxlint_validate_path', {
          path: 'src/old.ts',
          projectPath: path.join(repo, 'pkg'),
        }) as any;
        expect(result.exists).toBe(false);
        expect(result.renamed).toBe(true);
        expect(result.newPath).toBe('src/new.ts');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  describe('ctxlint_mcp_audit', () => {
    it('returns MCP config audit results with issues', () => {
      const result = callMcpTool('ctxlint_mcp_audit', {
        projectPath: path.join(FIXTURES, 'mcp-configs', 'wrong-root-key'),
      }) as any;
      expect(result.files).toBeDefined();
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.summary.errors).toBeGreaterThan(0);
    });

    it('filters by specific MCP checks', () => {
      const result = callMcpTool('ctxlint_mcp_audit', {
        projectPath: path.join(FIXTURES, 'mcp-configs', 'wrong-root-key'),
        checks: ['mcp-schema'],
      }) as any;
      expect(result.files).toBeDefined();
      expect(result.summary.errors).toBeGreaterThan(0);
    });
  });

  describe('ctxlint_fix', () => {
    // A temp-dir project with one broken, auto-fixable path: CLAUDE.md points
    // at lib/helpers.ts while the file lives at src/helpers.ts. The basename
    // fuzzy match generates the fix without git history, and the temp copy
    // keeps the write out of the shared fixtures.
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-mcp-fix-'));
      fs.mkdirSync(path.join(tmpDir, 'src'));
      fs.writeFileSync(path.join(tmpDir, 'src', 'helpers.ts'), 'export {};\n');
      fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Project\n\n- Utils: `lib/helpers.ts`\n');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('applies fixes and reports post-fix remainingIssues', () => {
      const result = callMcpTool('ctxlint_fix', {
        projectPath: tmpDir,
        checks: ['paths'],
      }) as any;
      expect(result.totalFixes).toBe(1);
      expect(result.filesModified).toHaveLength(1);
      // remainingIssues is the post-fix re-audit summary. The pre-fix summary
      // (1 error) would tell the host agent the fix did nothing.
      expect(result.remainingIssues.errors).toBe(0);
      expect(fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8')).toContain('src/helpers.ts');
    });

    it('reports zero fixes and an unchanged summary when nothing is fixable', () => {
      const result = callMcpTool('ctxlint_fix', {
        projectPath: path.join(FIXTURES, 'healthy-project'),
        checks: ['paths'],
      }) as any;
      expect(result.totalFixes).toBe(0);
      expect(result.filesModified).toHaveLength(0);
      expect(result.remainingIssues.errors).toBe(0);
    });

    it('dryRun: reports fixes without writing the file', () => {
      const originalContent = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      const result = callMcpTool('ctxlint_fix', {
        projectPath: tmpDir,
        checks: ['paths'],
        dryRun: true,
      }) as any;
      // Should identify at least one fixable path
      expect(result.dryRun).toBe(true);
      expect(result.totalFixes).toBeGreaterThanOrEqual(1);
      // File must be unchanged on disk
      const afterContent = fs.readFileSync(path.join(tmpDir, 'CLAUDE.md'), 'utf-8');
      expect(afterContent).toBe(originalContent);
      expect(afterContent).toContain('lib/helpers.ts');
    });

    it('dryRun: remainingIssues reflects pre-fix state (no re-audit)', () => {
      const result = callMcpTool('ctxlint_fix', {
        projectPath: tmpDir,
        checks: ['paths'],
        dryRun: true,
      }) as any;
      // No re-audit ran, so the broken path is still counted as an error
      expect(result.remainingIssues.errors).toBeGreaterThanOrEqual(1);
    });
  });

  describe('ctxlint_session_audit', () => {
    it('smoke: returns a session-audit bucket without crashing', () => {
      const result = callMcpTool('ctxlint_session_audit', {
        projectPath: path.join(FIXTURES, 'healthy-project'),
      }) as any;
      expect(result.version).toBe(VERSION);
      // The session bucket is always emitted when session checks ran, even
      // with zero issues -- environment contents vary, so assert shape only.
      expect(result.files.some((f: any) => f.path.includes('(session audit)'))).toBe(true);
    });
  });

  describe('ctxlint_skill_audit', () => {
    it('smoke: returns a skill-audit bucket without crashing', () => {
      const result = callMcpTool('ctxlint_skill_audit', {
        projectPath: path.join(FIXTURES, 'healthy-project'),
      }) as any;
      expect(result.version).toBe(VERSION);
      expect(result.files.some((f: any) => f.path.includes('(skill audit)'))).toBe(true);
    });

    it('rejects non-skill check names via the per-tool enum', () => {
      // 'paths' is a context check; the skill tool's enum must refuse it
      // instead of validating-then-silently-doing-nothing. Asserted on the
      // response itself: a bare toThrow() also passed when the server failed
      // to start at all.
      const responses = rpcResponses([
        INIT,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'ctxlint_skill_audit', arguments: { checks: ['paths'] } },
        },
      ]);
      expect(responses.get(1)?.result?.serverInfo?.name).toBe('ctxlint');
      const res = responses.get(2);
      const text: string = res?.error?.message ?? res?.result?.content?.[0]?.text ?? '';
      if (!res?.error) expect(res?.result?.isError).toBe(true);
      expect(text).toMatch(/invalid/i);
      expect(text).toContain('checks');
      expect(text).toContain('skill-frontmatter');
    });
  });

  describe('ctxlint_token_report', () => {
    it('returns token counts for context files', () => {
      const result = callMcpTool('ctxlint_token_report', {
        projectPath: path.join(FIXTURES, 'healthy-project'),
      }) as any;
      expect(result.files).toBeDefined();
      expect(result.files.length).toBeGreaterThan(0);
      expect(result.totalTokens).toBeGreaterThan(0);
      expect(result.files[0].path).toBe('CLAUDE.md');
      expect(result.files[0].tokens).toBeGreaterThan(0);
    });

    it('returns empty for project with no context files', () => {
      const result = callMcpTool('ctxlint_token_report', {
        projectPath: path.join(FIXTURES, 'healthy-project', 'src'),
      }) as any;
      expect(result.files).toHaveLength(0);
      expect(result.totalTokens).toBe(0);
    });
  });
});

/**
 * Send raw JSON-RPC lines to the server and return every response by id.
 * The helpers above hand back the PARSED tool text, which loses what these
 * tests are about: the text's own key order and formatting, and the
 * initialize result.
 */
function rpcResponses(requests: object[]): Map<number, any> {
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  let stdout: string;
  try {
    stdout = execFileSync('node', [SERVER_JS, '--mcp-server'], {
      input,
      encoding: 'utf-8',
      timeout: 60000,
    });
  } catch (err: any) {
    stdout = err.stdout || '';
  }
  const byId = new Map<number, any>();
  for (const line of stdout.trim().split('\n').filter(Boolean)) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.id === 'number') byId.set(parsed.id, parsed);
    } catch {
      continue;
    }
  }
  return byId;
}

const INIT = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  },
};

describe('MCP server output shape', () => {
  it('sends the routing instructions in the initialize result', () => {
    const init = rpcResponses([INIT]).get(1);
    const instructions: string = init?.result?.instructions;
    expect(typeof instructions).toBe('string');
    expect(instructions).toMatch(/ctxlint_token_report/);
    expect(instructions).toMatch(/dryRun/);
  });

  it('puts summary first in an audit result, compact rather than indented', () => {
    // Yaw MCP cuts an oversized result from the tail, so whatever comes last
    // is what a large project loses. The counters must not be that part.
    const responses = rpcResponses([
      INIT,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'ctxlint_audit',
          arguments: { projectPath: path.join(FIXTURES, 'broken-paths'), checks: ['paths'] },
        },
      },
    ]);
    const text: string = responses.get(2)?.result?.content?.[0]?.text;
    expect(text.startsWith('{"summary":{')).toBe(true);
    expect(text).not.toContain('\n');
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed)).toEqual([
      'summary',
      'version',
      'scannedAt',
      'projectRoot',
      'files',
    ]);
    expect(parsed.summary.errors).toBeGreaterThan(0);
  });
});

// One `serve` process answers many audits. A process-global per-file cache
// used to replay a previous call's issues for a different `checks` list and
// drop every cross-file "(project)" finding on an identical second call.
describe('MCP server repeated audits in one process', () => {
  const audit = (id: number, projectPath: string, checks: string[]) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'ctxlint_audit', arguments: { projectPath, checks } },
  });
  const files = (response: any) => JSON.parse(response?.result?.content?.[0]?.text).files;

  it('runs each call fresh: a changed checks list and an identical repeat both report correctly', () => {
    const broken = path.join(FIXTURES, 'broken-paths');
    const contradictions = path.join(FIXTURES, 'contradictions');
    const responses = rpcResponses([
      INIT,
      audit(2, broken, ['tokens']),
      audit(3, broken, ['paths']),
      audit(4, contradictions, ['contradictions']),
      audit(5, contradictions, ['contradictions']),
    ]);

    const pathIssues = files(responses.get(3)).flatMap((f: any) =>
      f.issues.filter((i: any) => i.check === 'paths'),
    );
    expect(pathIssues.length).toBeGreaterThan(0);

    const first = files(responses.get(4));
    expect(first.some((f: any) => f.path === '(project)' && f.issues.length > 0)).toBe(true);
    expect(files(responses.get(5))).toEqual(first);
  });
});

// Audit tools serialize the whole LintResult. A check that echoes source text
// (tier-tokens quotes the directive line) or carries the literal secret in
// fix.oldText (mcp-security) must not hand the token to the calling model.
describe('MCP server secret redaction', () => {
  const GHP = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-mcp-redact-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const call = (id: number, name: string, args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  it('ctxlint_mcp_audit and ctxlint_audit responses never contain the token', () => {
    execFileSync('git', ['init', '-q'], { cwd: root });
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      `{"mcpServers":{"gh":{"command":"npx","args":["-y","gh-mcp"],"env":{"GITHUB_TOKEN":"${GHP}"}}}}\n`,
    );
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      `# Rules\n\nNEVER run \`curl -H "Authorization: Bearer ${GHP}" https://api.example.com\`.\n`,
    );
    execFileSync('git', ['add', '.'], { cwd: root });

    const responses = rpcResponses([
      INIT,
      call(2, 'ctxlint_mcp_audit', { projectPath: root, checks: ['mcp-security'] }),
      call(3, 'ctxlint_audit', { projectPath: root, checks: ['tier-tokens'] }),
    ]);
    const mcpText: string = responses.get(2)?.result?.content?.[0]?.text;
    const auditTextOut: string = responses.get(3)?.result?.content?.[0]?.text;

    // The findings are still reported...
    const mcpIssues = JSON.parse(mcpText).files.flatMap((f: any) => f.issues);
    expect(mcpIssues.some((i: any) => i.ruleId === 'mcp-security/hardcoded-api-key')).toBe(true);
    const ctxIssues = JSON.parse(auditTextOut).files.flatMap((f: any) => f.issues);
    expect(ctxIssues.some((i: any) => i.ruleId === 'tier-tokens/hard-enforcement-missing')).toBe(
      true,
    );
    // ...without the secret.
    expect(mcpText).not.toContain(GHP);
    expect(auditTextOut).not.toContain(GHP);
  });
});

describe('MCP server input validation', () => {
  const call = (id: number, name: string, args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const textOf = (r: any): string => r?.result?.content?.[0]?.text ?? '';

  it.runIf(process.platform === 'win32')('rejects UNC and device projectPaths on win32', () => {
    // \\?\C:\ is a directory that exists, so only the UNC/device guard can
    // refuse it; \\host\share would make stat open an SMB session.
    const responses = rpcResponses([
      INIT,
      call(2, 'ctxlint_audit', { projectPath: '\\\\?\\C:\\', checks: ['paths'] }),
      call(3, 'ctxlint_token_report', { projectPath: '//localhost/c$' }),
    ]);
    for (const id of [2, 3]) {
      expect(responses.get(id)?.result?.isError).toBe(true);
      expect(JSON.parse(textOf(responses.get(id))).error).toMatch(/UNC and device paths/);
    }
  });

  it('accepts an in-root name that starts with ".."', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-dotdot-'));
    try {
      fs.writeFileSync(path.join(root, '..notes.md'), 'x\n');
      const responses = rpcResponses([
        INIT,
        call(2, 'ctxlint_validate_path', { path: '..notes.md', projectPath: root }),
        call(3, 'ctxlint_validate_path', { path: '../outside.md', projectPath: root }),
      ]);
      expect(JSON.parse(textOf(responses.get(2)))).toMatchObject({ exists: true });
      expect(JSON.parse(textOf(responses.get(3))).error).toMatch(/escape/i);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks every tool that reads outside the project root as open-world', () => {
    const responses = rpcResponses([
      INIT,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ]);
    const tools: any[] = responses.get(2)?.result?.tools ?? [];
    const hint = (name: string) =>
      tools.find((t) => t.name === name)?.annotations?.openWorldHint as boolean | undefined;
    // includeGlobal reads the home directory's MCP configs.
    expect(hint('ctxlint_mcp_audit')).toBe(true);
    expect(hint('ctxlint_session_audit')).toBe(true);
    expect(hint('ctxlint_skill_audit')).toBe(true);
    expect(hint('ctxlint_audit')).toBe(false);
    const fix = tools.find((t) => t.name === 'ctxlint_fix');
    expect(fix.description).toMatch(/every auto-fix/);
  });
});

describe('auditText size cap', () => {
  const big = (): LintResult => ({
    version: VERSION,
    scannedAt: '2026-01-01T00:00:00Z',
    projectRoot: '/p',
    files: Array.from({ length: 50 }, (_, f) => ({
      path: `dir${f}/CLAUDE.md`,
      isSymlink: false,
      tokens: 10,
      lines: 10,
      issues: Array.from({ length: 20 }, (_, i) => ({
        severity: 'warning' as const,
        check: 'paths' as const,
        line: i + 1,
        message: `missing path number ${i} in file ${f} `.padEnd(120, '.'),
      })),
    })),
    summary: { errors: 0, warnings: 1000, info: 0, totalTokens: 500, estimatedWaste: 0 },
  });

  it('returns the full result when it fits', () => {
    const text = auditText(big(), 10_000_000);
    expect(JSON.parse(text).truncated).toBeUndefined();
    expect(JSON.parse(text).files).toHaveLength(50);
  });

  it('drops trailing issues to fit, stays valid JSON and says how much was left out', () => {
    const max = 20_000;
    const text = auditText(big(), max);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(max);
    const parsed = JSON.parse(text);
    expect(Object.keys(parsed).slice(0, 2)).toEqual(['summary', 'truncated']);
    const kept = parsed.files.reduce((n: number, f: any) => n + f.issues.length, 0);
    expect(kept).toBeGreaterThan(0);
    expect(parsed.truncated.droppedIssues).toBe(1000 - kept);
    expect(parsed.truncated.droppedFiles).toBe(50 - parsed.files.length);
    // summary still counts every finding; kept issues are the leading ones.
    expect(parsed.summary.warnings).toBe(1000);
    expect(parsed.files[0].path).toBe('dir0/CLAUDE.md');
    expect(parsed.files[0].issues[0].line).toBe(1);
  });

  it('keeps the cap under the default host limit', () => {
    // Yaw MCP cuts at YAW_MCP_MAX_RESULT_BYTES (default 100000).
    expect(MAX_AUDIT_TEXT_BYTES).toBeLessThan(100_000);
    expect(Buffer.byteLength(auditText(big()), 'utf8')).toBeLessThanOrEqual(MAX_AUDIT_TEXT_BYTES);
  });
});
