import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runAudit, ALL_MCP_CHECKS } from '../audit.js';

// End-to-end coverage for the on-disk MCP fixtures under fixtures/mcp-configs/
// that the unit tests (which build configs from inline strings) do not read.
// Each case pins the exact rule ids the fixture exists to produce, so a fixture
// that silently goes inert fails here.

const FIXTURES = path.resolve(__dirname, '../../../fixtures/mcp-configs');

async function findings(root: string): Promise<Array<{ path: string; ruleId: string }>> {
  const result = await runAudit(root, ALL_MCP_CHECKS, { mcp: true, mcpOnly: true });
  return result.files.flatMap((f) =>
    f.issues
      // unset-variable depends on the environment running the suite.
      .filter((i) => i.ruleId !== 'mcp-env/unset-variable')
      .map((i) => ({ path: f.path.replace(/\\/g, '/'), ruleId: i.ruleId ?? '' })),
  );
}

describe('fixtures/mcp-configs end to end', () => {
  it('cross-client-drift: one same-server-different-config per pair of clients', async () => {
    const ids = (await findings(path.join(FIXTURES, 'cross-client-drift'))).map((f) => f.ruleId);
    expect(ids).toEqual([
      'mcp-consistency/same-server-different-config',
      'mcp-consistency/same-server-different-config',
      'mcp-consistency/same-server-different-config',
    ]);
  });

  it('deprecated-sse: flags the SSE transport', async () => {
    expect(await findings(path.join(FIXTURES, 'deprecated-sse'))).toEqual([
      { path: '.mcp.json', ruleId: 'mcp-deprecated/sse-transport' },
    ]);
  });

  it('duplicate-names: flags the repeated server key', async () => {
    const ids = (await findings(path.join(FIXTURES, 'duplicate-names'))).map((f) => f.ruleId);
    expect(ids).toEqual(['mcp-consistency/duplicate-server-name']);
  });

  it("wrong-env-syntax: each file uses the other client's syntax", async () => {
    const got = await findings(path.join(FIXTURES, 'wrong-env-syntax'));
    expect(got).toEqual(
      expect.arrayContaining([
        { path: '.cursor/mcp.json', ruleId: 'mcp-env/wrong-syntax' },
        { path: '.mcp.json', ruleId: 'mcp-env/wrong-syntax' },
      ]),
    );
    expect(got).toHaveLength(2);
  });

  describe('untracked-secrets', () => {
    let tmp: string | undefined;
    afterEach(() => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      tmp = undefined;
    });

    // The fixture is only a .gitignore that ignores .mcp.json, so a clone never
    // has the config itself. Rebuild it in a throwaway repo: the secret rules
    // fire only on git-tracked files, so an ignored config must stay silent.
    it('a gitignored config with a literal token reports no secret finding', async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-untracked-'));
      execFileSync('git', ['init', '-q'], { cwd: tmp });
      fs.copyFileSync(
        path.join(FIXTURES, 'untracked-secrets', '.gitignore'),
        path.join(tmp, '.gitignore'),
      );
      const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`.slice(0, 40);
      fs.writeFileSync(
        path.join(tmp, '.mcp.json'),
        JSON.stringify(
          {
            mcpServers: {
              gh: { command: 'npx', args: ['-y', 'gh-mcp'], env: { GITHUB_TOKEN: token } },
            },
          },
          null,
          2,
        ),
      );

      const ids = (await findings(tmp)).map((f) => f.ruleId);
      expect(ids.filter((id) => id.startsWith('mcp-security/'))).toEqual([]);

      // Control: the same file, once tracked, is reported.
      execFileSync('git', ['add', '-f', '.mcp.json'], { cwd: tmp });
      const tracked = (await findings(tmp)).map((f) => f.ruleId);
      expect(tracked).toContain('mcp-security/hardcoded-api-key');
    });
  });
});
