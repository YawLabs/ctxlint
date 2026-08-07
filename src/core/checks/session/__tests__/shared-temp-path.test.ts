import { describe, expect, it } from 'vitest';
import type { HistoryEntry, SessionContext } from '../../../types.js';
import { checkSharedTempPath } from '../shared-temp-path.js';

let clock = 0;
function cmd(display: string): HistoryEntry {
  return {
    display,
    timestamp: ++clock,
    project: '/repo/a',
    sessionId: 's1',
    provider: 'claude-code',
  };
}

function ctx(history: HistoryEntry[]): SessionContext {
  return { history, memories: [], siblings: [], currentProject: '/repo/a', providers: ['claude-code'] };
}

describe('session/shared-temp-path', () => {
  it('flags the write-then-restore pair that caused the real incident', async () => {
    const issues = await checkSharedTempPath(
      ctx([
        cmd(`node -e 'fs.writeFileSync("/tmp/pkg.bak", fs.readFileSync("package.json"))'`),
        cmd('npm pack --dry-run'),
        cmd('cp /tmp/pkg.bak package.json'),
      ]),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('session-shared-temp-path/shared-temp-path');
    expect(issues[0].message).toContain('/tmp/pkg.bak');
    // The detail must name BOTH sides -- the pair is the finding.
    expect(issues[0].detail).toContain('writeFileSync');
    expect(issues[0].detail).toContain('cp /tmp/pkg.bak');
  });

  it('flags a shell redirect written then read back', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('git diff > /tmp/patch.diff'), cmd('git apply < /tmp/patch.diff')]),
    );
    expect(issues).toHaveLength(1);
  });

  it('does not flag mktemp output -- that is the correct form', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('T=$(mktemp) && cp package.json "$T"'), cmd('cp "$T" package.json')]),
    );
    expect(issues).toHaveLength(0);
  });

  it('does not flag a path carrying a per-run component', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('cp package.json /tmp/pkg-$$.bak'), cmd('cp /tmp/pkg-$$.bak package.json')]),
    );
    expect(issues).toHaveLength(0);
  });

  it('does not flag a write that is never read back', async () => {
    // A scratch file nobody restores from cannot be clobbered into the workspace.
    const issues = await checkSharedTempPath(ctx([cmd('npm test > /tmp/test.log'), cmd('echo done')]));
    expect(issues).toHaveLength(0);
  });

  it('does not flag a read with no preceding write', async () => {
    const issues = await checkSharedTempPath(ctx([cmd('cat /tmp/provided-by-someone-else.txt')]));
    expect(issues).toHaveLength(0);
  });

  it('requires the write to PRECEDE the read, not merely co-occur', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('cp /tmp/x.bak package.json'), cmd('cp package.json /tmp/x.bak')]),
    );
    expect(issues).toHaveLength(0);
  });

  it('reports a given path once, not once per later read', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('cp a /tmp/x.bak'), cmd('cp /tmp/x.bak b'), cmd('cp /tmp/x.bak c')]),
    );
    expect(issues).toHaveLength(1);
  });

  it('ignores a bare temp root -- a directory is not a clobberable file', async () => {
    const issues = await checkSharedTempPath(ctx([cmd('cp a /tmp/'), cmd('cp /tmp/ b')]));
    expect(issues).toHaveLength(0);
  });

  it('covers the Windows %TEMP% form', async () => {
    const issues = await checkSharedTempPath(
      ctx([cmd('copy pkg.json %TEMP%\\pkg.bak'), cmd('cp %TEMP%\\pkg.bak pkg.json')]),
    );
    expect(issues.length).toBeGreaterThan(0);
  });
});
