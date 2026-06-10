import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VERSION } from '../../version.js';

const SERVER_JS = path.resolve(__dirname, '../../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../../fixtures');

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
      timeout: 15000,
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
      timeout: 15000,
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

    it('accepts a legitimate nested relative path', () => {
      // Sanity check that the traversal guard doesn't block normal paths
      // that happen to contain segments resolvable inside the root.
      const result = callMcpTool('ctxlint_validate_path', {
        path: './src/app.ts',
        projectPath: path.join(FIXTURES, 'broken-paths'),
      });
      expect(result.exists).toBe(true);
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
      // instead of validating-then-silently-doing-nothing.
      expect(() => callMcpTool('ctxlint_skill_audit', { checks: ['paths'] })).toThrow();
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
