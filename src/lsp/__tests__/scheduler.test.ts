import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAuditScheduler } from '../server.js';

// The LSP re-audits against the real project root (a project walk plus git
// spawns, ~0.3-0.5 s). These pin the scheduler that keeps that off the
// keystroke path: per-URI debounce, serial runs, and caches kept across
// keystrokes until something says the project changed.

let clock = 0;
let calls: Array<{ uri: string; fresh: boolean }>;

function make(run?: (uri: string, fresh: boolean) => Promise<void>) {
  return createAuditScheduler({
    delayMs: 300,
    maxCacheAgeMs: 30_000,
    now: () => clock,
    run:
      run ??
      (async (uri, fresh) => {
        calls.push({ uri, fresh });
      }),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  calls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAuditScheduler', () => {
  it('audits a burst of keystrokes once, after the quiet period', async () => {
    const s = make();
    for (let i = 0; i < 10; i++) {
      s.schedule('file:///a.md');
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(300);
    await s.idle();
    expect(calls.map((c) => c.uri)).toEqual(['file:///a.md']);
  });

  it('debounces per URI: an edit to one document does not delay another', async () => {
    const s = make();
    s.schedule('file:///a.md');
    await vi.advanceTimersByTimeAsync(200);
    s.schedule('file:///b.md');
    await vi.advanceTimersByTimeAsync(100);
    await s.idle();
    expect(calls.map((c) => c.uri)).toEqual(['file:///a.md']);
    await vi.advanceTimersByTimeAsync(200);
    await s.idle();
    expect(calls.map((c) => c.uri)).toEqual(['file:///a.md', 'file:///b.md']);
  });

  it('keeps caches across keystrokes and rebuilds them only after invalidate()', async () => {
    const s = make();
    const edit = async () => {
      s.schedule('file:///a.md');
      await vi.advanceTimersByTimeAsync(300);
      await s.idle();
    };
    await edit(); // first audit builds them
    await edit();
    await edit();
    s.invalidate(); // didSave / didClose / watched-file change
    await edit();
    await edit();
    expect(calls.map((c) => c.fresh)).toEqual([true, false, false, true, false]);
  });

  it('rebuilds caches once they are older than the max age', async () => {
    const s = make();
    s.schedule('file:///a.md');
    await vi.advanceTimersByTimeAsync(300);
    await s.idle();
    clock = 30_000;
    s.schedule('file:///a.md');
    await vi.advanceTimersByTimeAsync(300);
    await s.idle();
    expect(calls.map((c) => c.fresh)).toEqual([true, true]);
  });

  it('never overlaps runs, so results publish in the order the audits became due', async () => {
    const log: string[] = [];
    let release: () => void = () => {};
    const s = make(async (uri) => {
      log.push(`start ${uri}`);
      if (uri === 'file:///slow.md') await new Promise<void>((r) => (release = r));
      log.push(`end ${uri}`);
    });
    s.schedule('file:///slow.md');
    await vi.advanceTimersByTimeAsync(300);
    s.schedule('file:///fast.md');
    await vi.advanceTimersByTimeAsync(300);
    expect(log).toEqual(['start file:///slow.md']);
    release();
    await s.idle();
    expect(log).toEqual([
      'start file:///slow.md',
      'end file:///slow.md',
      'start file:///fast.md',
      'end file:///fast.md',
    ]);
  });

  it('cancel() drops a pending audit, and a throwing run does not wedge the queue', async () => {
    const s = make(async (uri) => {
      calls.push({ uri, fresh: false });
      if (uri === 'file:///boom.md') throw new Error('boom');
    });
    s.schedule('file:///closed.md');
    s.cancel('file:///closed.md');
    s.schedule('file:///boom.md');
    await vi.advanceTimersByTimeAsync(300);
    await s.idle();
    s.schedule('file:///after.md');
    await vi.advanceTimersByTimeAsync(300);
    await s.idle();
    expect(calls.map((c) => c.uri)).toEqual(['file:///boom.md', 'file:///after.md']);
  });
});
