import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { watchTree } from '../cli.js';

// watchTree's per-directory mode is what --watch uses on Linux, where Node's
// emulated `recursive` would also watch node_modules (slow start, inotify
// ENOSPC). Forced here (recursive=false) so it runs on every platform.
describe('watchTree (per-directory mode)', () => {
  let dir: string;
  let handle: { close(): void; dirs(): string[] } | undefined;

  afterEach(() => {
    handle?.close();
    handle = undefined;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  async function until(pred: () => boolean, what: string, ms = 15000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it('skips ignored directories and picks up directories created later', async () => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-wt-')));
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'packages', 'app'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.git'));

    const events: Array<string | null> = [];
    const errors: Error[] = [];
    handle = watchTree(
      dir,
      (rel) => events.push(rel),
      (err) => errors.push(err),
      false,
    );

    const rels = () => handle!.dirs().map((d) => path.relative(dir, d).replace(/\\/g, '/'));
    expect(rels().sort()).toEqual(['', 'packages', 'packages/app']);

    fs.writeFileSync(path.join(dir, 'packages', 'app', 'CLAUDE.md'), '# App\n');
    await until(() => events.includes('packages/app/CLAUDE.md'), 'nested edit event');

    fs.mkdirSync(path.join(dir, 'later'));
    await until(() => rels().includes('later'), 'watcher on the new dir');
    fs.writeFileSync(path.join(dir, 'later', 'CLAUDE.md'), '# Later\n');
    await until(() => events.includes('later/CLAUDE.md'), 'event inside the new dir');

    // An ignored dir created after start is not watched either.
    fs.mkdirSync(path.join(dir, 'packages', 'node_modules'));
    await until(() => events.includes('packages/node_modules'), 'ignored dir event');
    expect(rels()).not.toContain('packages/node_modules');

    expect(errors).toEqual([]);
  }, 60000);

  it('reports a failure to watch the root to the caller', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-wt-'));
    expect(() =>
      watchTree(
        path.join(dir, 'missing'),
        () => {},
        () => {},
        false,
      ),
    ).toThrow(/ENOENT/);
  });
});
