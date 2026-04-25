import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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

describe('MCP server tools', () => {
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

  describe('ctxlint_mcph_audit', () => {
    it('returns a well-formed result on a project with no .mcph.json', () => {
      // healthy-project ships no .mcph.json — the tool should still respond
      // with a valid LintResult (zero issues, zero files) instead of erroring,
      // and prove the new tool is wired into the server's tools/list.
      const result = callMcpTool('ctxlint_mcph_audit', {
        projectPath: path.join(FIXTURES, 'healthy-project'),
      }) as any;
      expect(result.version).toBe(VERSION);
      expect(Array.isArray(result.files)).toBe(true);
      expect(result.summary).toBeDefined();
      expect(typeof result.summary.errors).toBe('number');
    });

    it('accepts the strictEnvToken flag without erroring', () => {
      const result = callMcpTool('ctxlint_mcph_audit', {
        projectPath: path.join(FIXTURES, 'healthy-project'),
        strictEnvToken: true,
      }) as any;
      expect(result.version).toBe(VERSION);
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
