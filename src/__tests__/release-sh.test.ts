import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const releaseSh = readFileSync(fileURLToPath(new URL('../../release.sh', import.meta.url)), 'utf8');

describe('release.sh MCP Registry calls', () => {
  // mcp-publisher waits for the registry's answer with no limit of its own, so
  // release.sh runs each call to it -- every login and every publish attempt --
  // through mcp_bounded, its time limit. A call added or edited without it
  // would hang the release on a registry that never answers.
  it('runs every mcp-publisher login and publish through mcp_bounded', () => {
    const calls = releaseSh
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#') && /"\$MP" (login|publish)\b/.test(line));
    expect(calls.filter((line) => line.includes('"$MP" login')).length).toBeGreaterThanOrEqual(2);
    expect(calls.filter((line) => line.includes('"$MP" publish')).length).toBeGreaterThanOrEqual(1);
    for (const line of calls) {
      expect(line, 'release.sh runs mcp-publisher without its time limit').toMatch(
        /mcp_bounded "\$MP" (login|publish)\b/,
      );
    }
  });

  // A first login the limit stopped is the registry not answering, not a bad
  // token: mcp_login_fail says so, where a bare fail would blame the token.
  it('fails a first login through mcp_login_fail', () => {
    expect(releaseSh).toMatch(/^mcp_login_fail\(\) \{$/m);
    expect(releaseSh).toMatch(/mcp_login_fail "mcp-publisher (OIDC )?login failed/);
    expect(releaseSh).not.toMatch(/\bfail "mcp-publisher (OIDC )?login failed/);
  });

  // The first mcp_bounded call sets the limit up; a flag inherited from the
  // environment must not stand in for that.
  it('sets the time limit up itself, whatever the environment carries', () => {
    expect(releaseSh).toMatch(/^MCP_TIMEOUT_READY=""$/m);
  });
});
