import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeProjectDir, projectDirCandidates } from '../../../session-parser.js';
import type { SessionContext } from '../../../types.js';
import { checkMemoryIndexOverflow } from '../memory-index-overflow.js';

const roots: string[] = [];
const prev = { home: process.env.HOME, profile: process.env.USERPROFILE };

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  if (prev.home === undefined) delete process.env.HOME;
  else process.env.HOME = prev.home;
  if (prev.profile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prev.profile;
});

/** Write MEMORY.md under an explicitly chosen encoded dir name. */
function seed(encodedDir: string, lines: number): string {
  const home = mkdtempSync(join(tmpdir(), 'ctxlint-mem-'));
  roots.push(home);
  const dir = join(home, '.claude', 'projects', encodedDir, 'memory');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'MEMORY.md'), `${Array.from({ length: lines }, (_, i) => `- entry ${i}`).join('\n')}\n`);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

function ctx(project: string): SessionContext {
  return { history: [], memories: [], siblings: [], currentProject: project, providers: ['claude-code'] };
}

describe('projectDirCandidates', () => {
  it('offers the folded form for a path containing an underscore', () => {
    expect(projectDirCandidates('C:/Users/x/yaw/mcp_servers/npmjs-mcp')).toEqual([
      'C--Users-x-yaw-mcp_servers-npmjs-mcp',
      'C--Users-x-yaw-mcp-servers-npmjs-mcp',
    ]);
  });

  it('offers a single candidate when there is no underscore', () => {
    const p = 'C:/Users/x/yaw/plain/repo';
    expect(projectDirCandidates(p)).toEqual([encodeProjectDir(p)]);
  });
});

describe('session/memory-index-overflow underscore encoding', () => {
  const PROJECT = 'C:/Users/x/yaw/oam_js_runtime/oam';

  it('finds MEMORY.md under the FOLDED dir name Claude Code actually creates', async () => {
    // The regression: this is the only directory that exists on a current
    // machine for an underscore path, and the check used to look solely under
    // encodeProjectDir()'s unfolded form -- so it silently never fired.
    seed('C--Users-x-yaw-oam-js-runtime-oam', 260);
    const issues = await checkMemoryIndexOverflow(ctx(PROJECT));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toContain('260');
  });

  it('still finds MEMORY.md under the legacy unfolded dir name', async () => {
    seed(encodeProjectDir(PROJECT), 260);
    const issues = await checkMemoryIndexOverflow(ctx(PROJECT));
    expect(issues.length).toBeGreaterThan(0);
  });

  it('stays silent when neither encoding has a MEMORY.md', async () => {
    seed('C--some-unrelated-project', 260);
    expect(await checkMemoryIndexOverflow(ctx(PROJECT))).toEqual([]);
  });
});
