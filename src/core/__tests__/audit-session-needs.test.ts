import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'node:os';
import type { SessionDataNeeds } from '../session-scanner.js';

// scanSessionData streams every provider's history.jsonl, parses every
// project's memories and spawns git per sibling repo. runAudit must ask only
// for the parts its selected session checks read.
const scanSessionData = vi.fn(async (projectRoot: string, _needs?: SessionDataNeeds) => ({
  history: [],
  memories: [],
  siblings: [],
  currentProject: projectRoot.replace(/\\/g, '/'),
  providers: [],
}));

vi.mock('../session-scanner.js', () => ({ scanSessionData }));

const { runAudit } = await import('../audit.js');

describe('runAudit session data needs', () => {
  beforeEach(() => {
    scanSessionData.mockClear();
  });

  const needsFor = async (checks: string[]) => {
    await runAudit(os.tmpdir(), checks as never, { sessionOnly: true });
    expect(scanSessionData).toHaveBeenCalledTimes(1);
    return scanSessionData.mock.calls[0][1];
  };

  it('a transcript-only selection reads no history, memories or siblings', async () => {
    expect(await needsFor(['session-large-read', 'session-memory-index-overflow'])).toEqual({
      history: false,
      memories: false,
      siblings: false,
    });
  });

  it('history: loop-detection, missing-secret, shared-temp-path', async () => {
    for (const c of ['session-loop-detection', 'session-shared-temp-path']) {
      scanSessionData.mockClear();
      expect(await needsFor([c])).toEqual({ history: true, memories: false, siblings: false });
    }
  });

  it('memories: stale-memory, duplicate-memory; unresolvable-sha also reads siblings', async () => {
    for (const c of ['session-stale-memory', 'session-duplicate-memory']) {
      scanSessionData.mockClear();
      expect(await needsFor([c])).toEqual({ history: false, memories: true, siblings: false });
    }
    scanSessionData.mockClear();
    // unresolvable-sha matches sibling repo names to attribute a SHA elsewhere.
    expect(await needsFor(['session-unresolvable-sha'])).toEqual({
      history: false,
      memories: true,
      siblings: true,
    });
  });

  it('siblings: diverged-file, missing-workflow; missing-secret also reads history', async () => {
    for (const c of ['session-diverged-file', 'session-missing-workflow']) {
      scanSessionData.mockClear();
      expect(await needsFor([c])).toEqual({ history: false, memories: false, siblings: true });
    }
    scanSessionData.mockClear();
    expect(await needsFor(['session-missing-secret'])).toEqual({
      history: true,
      memories: false,
      siblings: true,
    });
  });

  it('the full session pillar asks for everything', async () => {
    await runAudit(os.tmpdir(), [], { sessionOnly: true });
    expect(scanSessionData.mock.calls[0][1]).toEqual({
      history: true,
      memories: true,
      siblings: true,
    });
  });
});
