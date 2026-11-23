import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// Spawns the BUILT server: run `node build.mjs` before this file.
const CLI = path.resolve(__dirname, '../../../dist/index.js');
const FIXTURES = path.resolve(__dirname, '../../../fixtures');

// Generous per-wait ceiling: a spawn on a contended Windows box is slow, but a
// broken server must still fail the test rather than hang it.
const WAIT_MS = 30000;
// Hard per-test ceiling, above every WAIT_MS a test can chain plus its settle
// window, so a wedged server fails the test instead of the run.
const TEST_MS = 90000;
// After the diagnostics a test is waiting for arrive, how long to keep
// listening for a stray late publish (a duplicate audit, a stale result).
const SETTLE_MS = 3000;

interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

/** Minimal LSP client: Content-Length framing over the child's stdio. */
class LspClient {
  private buffer = Buffer.alloc(0);
  readonly messages: Message[] = [];
  private waiters: Array<() => void> = [];
  private nextId = 1;
  exited = false;
  stderr = '';

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });
    child.on('exit', () => {
      this.exited = true;
      this.notify();
    });
  }

  private drain(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length: *(\d+)/i.exec(header);
      if (!match) throw new Error(`bad LSP header: ${header}`);
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString('utf-8');
      this.buffer = this.buffer.subarray(start + length);
      this.messages.push(JSON.parse(body));
      this.notify();
    }
  }

  private notify(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w();
  }

  send(message: Message): void {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`);
  }

  request(method: string, params: unknown): number {
    const id = this.nextId++;
    this.send({ id, method, params });
    return id;
  }

  /**
   * Resolve with the first message at index >= `from` matching `pred`, or
   * reject on timeout / exit.
   */
  waitFor(pred: (m: Message) => boolean, what: string, from = 0): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`timed out waiting for ${what}; stderr: ${this.stderr}`));
      }, WAIT_MS);
      const check = (): void => {
        const found = this.messages.slice(from).find(pred);
        if (found) {
          clearTimeout(timer);
          resolve(found);
        } else if (this.exited) {
          clearTimeout(timer);
          reject(new Error(`server exited while waiting for ${what}; stderr: ${this.stderr}`));
        } else {
          this.waiters.push(check);
        }
      };
      check();
    });
  }

  /** Every publishDiagnostics for `uri`, in arrival order. */
  published(uri: string): Message[] {
    return this.messages.filter(
      (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
    );
  }

  async initialize(): Promise<void> {
    const id = this.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });
    const response = await this.waitFor((m) => m.id === id, 'initialize response');
    expect(response.error).toBeUndefined();
    this.send({ method: 'initialized', params: {} });
  }

  open(uri: string, text: string, version = 1): void {
    this.send({
      method: 'textDocument/didOpen',
      params: { textDocument: { uri, languageId: 'markdown', version, text } },
    });
  }

  change(uri: string, text: string, version: number): void {
    this.send({
      method: 'textDocument/didChange',
      params: { textDocument: { uri, version }, contentChanges: [{ text }] },
    });
  }

  close(uri: string): void {
    this.send({ method: 'textDocument/didClose', params: { textDocument: { uri } } });
  }
}

const children: ChildProcessWithoutNullStreams[] = [];

function startServer(args: string[]): LspClient {
  const child = spawn('node', [CLI, ...args], { stdio: 'pipe' });
  children.push(child);
  return new LspClient(child);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codes(m: Message): string[] {
  return m.params.diagnostics.map((d: { code: string }) => d.code);
}

function messagesOf(m: Message): string {
  return m.params.diagnostics.map((d: { message: string }) => d.message).join('\n');
}

// A throwaway project: package.json with build/test scripts, src/index.ts, and
// an on-disk CLAUDE.md whose references all resolve.
let project: string;
const DISK_CLAUDE = '# Project\n\n- Source: `src/index.ts`\n';

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-lsp-test-'));
  fs.writeFileSync(
    path.join(project, 'package.json'),
    JSON.stringify({ name: 'p', scripts: { build: 'tsc', test: 'vitest run' } }),
  );
  fs.mkdirSync(path.join(project, 'src'));
  fs.writeFileSync(path.join(project, 'src', 'index.ts'), 'export {};\n');
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), DISK_CLAUDE);
});

// One hook, in this order: every server is killed and REAPED before its
// project dir is removed -- Windows refuses to delete a tree a dying process
// still holds (EPERM), and a leaked child would outlive the run.
afterEach(async () => {
  await Promise.all(
    children.splice(0).map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      return exited;
    }),
  );
  fs.rmSync(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

describe('ctxlint --lsp', () => {
  it(
    'serves over stdio with plain --lsp and audits the buffer against the real project',
    async () => {
      const client = startServer(['--lsp']);
      await client.initialize();

      const file = path.join(FIXTURES, 'healthy-project', 'CLAUDE.md');
      const uri = pathToFileURL(file).href;
      client.open(uri, fs.readFileSync(file, 'utf-8'));

      const published = await client.waitFor(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
        'publishDiagnostics',
      );
      expect(codes(published)).not.toContain('paths/not-found');
      expect(codes(published)).not.toContain('commands/package-json-missing');
    },
    TEST_MS,
  );

  it(
    'audits the editor buffer, not the file on disk',
    async () => {
      const client = startServer(['--lsp']);
      await client.initialize();

      // Disk resolves every reference; only the unsaved buffer names a missing file.
      const uri = pathToFileURL(path.join(project, 'CLAUDE.md')).href;
      client.open(uri, '# Project\n\n- Source: `src/missing-from-buffer.ts`\n');

      const published = await client.waitFor(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
        'publishDiagnostics',
      );
      expect(codes(published)).toContain('paths/not-found');
      expect(messagesOf(published)).toContain('src/missing-from-buffer.ts');
    },
    TEST_MS,
  );

  it(
    'audits a file in a subdirectory against the project root, not its own directory',
    async () => {
      const client = startServer(['--lsp']);
      await client.initialize();

      // docs/ has no package.json of its own: audited from docs/, the commands
      // check would report the "no package.json" notice for these scripts.
      fs.mkdirSync(path.join(project, 'docs'));
      const file = path.join(project, 'docs', 'CLAUDE.md');
      const text = '# Docs\n\n## Commands\n\n```bash\nnpm run build\nnpm test\n```\n';
      fs.writeFileSync(file, text);
      const uri = pathToFileURL(file).href;
      client.open(uri, text);

      const published = await client.waitFor(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
        'publishDiagnostics',
      );
      expect(codes(published)).not.toContain('commands/package-json-missing');
      expect(codes(published)).not.toContain('commands/script-not-found');
    },
    TEST_MS,
  );

  it(
    'audits each open exactly once',
    async () => {
      const client = startServer(['--lsp']);
      await client.initialize();

      const uri = pathToFileURL(path.join(project, 'CLAUDE.md')).href;
      client.open(uri, DISK_CLAUDE);
      await client.waitFor(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
        'publishDiagnostics',
      );
      await sleep(SETTLE_MS);
      expect(client.published(uri)).toHaveLength(1);
    },
    TEST_MS,
  );

  it(
    'clears the diagnostics of a closed document',
    async () => {
      const client = startServer(['--lsp']);
      await client.initialize();

      const uri = pathToFileURL(path.join(project, 'CLAUDE.md')).href;
      client.open(uri, '# Project\n\n- Source: `src/gone.ts`\n');
      const first = await client.waitFor(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
        'publishDiagnostics',
      );
      expect(first.params.diagnostics.length).toBeGreaterThan(0);

      const from = client.messages.length;
      client.close(uri);
      const cleared = await client.waitFor(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
        'publishDiagnostics after close',
        from,
      );
      expect(cleared.params.diagnostics).toEqual([]);
    },
    TEST_MS,
  );

  it(
    'after rapid edits the final diagnostics describe the latest version',
    async () => {
      const client = startServer(['--lsp']);
      await client.initialize();

      const uri = pathToFileURL(path.join(project, 'CLAUDE.md')).href;
      client.open(uri, DISK_CLAUDE);
      await client.waitFor(
        (m) => m.method === 'textDocument/publishDiagnostics' && m.params?.uri === uri,
        'initial publishDiagnostics',
      );

      client.change(uri, '# Project\n\n- Source: `src/version-two.ts`\n', 2);
      client.change(uri, '# Project\n\n- Source: `src/version-three.ts`\n', 3);
      await client.waitFor(
        (m) =>
          m.method === 'textDocument/publishDiagnostics' &&
          m.params?.uri === uri &&
          messagesOf(m).includes('version-three'),
        'publishDiagnostics for v3',
      );
      await sleep(SETTLE_MS);

      const all = client.published(uri);
      const last = all[all.length - 1];
      expect(messagesOf(last)).toContain('src/version-three.ts');
      expect(messagesOf(last)).not.toContain('version-two');
    },
    TEST_MS,
  );

  it(
    'a slow audit of a closed buffer does not publish over the reopened document',
    async () => {
      const client = startServer(['--lsp']);
      await client.initialize();

      const uri = pathToFileURL(path.join(project, 'CLAUDE.md')).href;
      // Clients reopen at version 1, so the old and new buffers share a
      // version number: only document identity tells them apart.
      client.open(uri, '# Project\n\n- Source: `src/before-close.ts`\n', 1);
      client.close(uri);
      client.open(uri, '# Project\n\n- Source: `src/after-reopen.ts`\n', 1);

      await client.waitFor(
        (m) =>
          m.method === 'textDocument/publishDiagnostics' &&
          m.params?.uri === uri &&
          messagesOf(m).includes('after-reopen'),
        'publishDiagnostics for the reopened buffer',
      );
      await sleep(SETTLE_MS);

      for (const m of client.published(uri)) {
        expect(messagesOf(m)).not.toContain('before-close');
      }
    },
    TEST_MS,
  );

  // didSave is when the project on disk changes and the caches kept across
  // keystrokes are rebuilt; the client only sends it when `save` is advertised.
  it(
    'advertises save notifications and audits a keystroke burst once',
    async () => {
      const client = startServer(['--lsp']);
      const id = client.request('initialize', {
        processId: process.pid,
        rootUri: null,
        capabilities: {},
      });
      const response = await client.waitFor((m) => m.id === id, 'initialize response');
      expect(response.result.capabilities.textDocumentSync).toMatchObject({
        openClose: true,
        change: 1,
        save: { includeText: false },
      });
      client.send({ method: 'initialized', params: {} });

      const uri = pathToFileURL(path.join(project, 'CLAUDE.md')).href;
      client.open(uri, DISK_CLAUDE);
      for (let v = 2; v <= 6; v++) {
        client.change(uri, `# Project\n\n- Source: \`src/burst-${v}.ts\`\n`, v);
      }
      await client.waitFor(
        (m) =>
          m.method === 'textDocument/publishDiagnostics' &&
          m.params?.uri === uri &&
          messagesOf(m).includes('burst-6'),
        'publishDiagnostics for the last edit',
      );
      await sleep(SETTLE_MS);
      expect(client.published(uri)).toHaveLength(1);
      client.send({ method: 'textDocument/didSave', params: { textDocument: { uri } } });
      const shutdown = client.request('shutdown', null);
      expect((await client.waitFor((m) => m.id === shutdown, 'shutdown')).error).toBeUndefined();
    },
    TEST_MS,
  );

  it(
    'keeps --lsp --stdio working',
    async () => {
      const client = startServer(['--lsp', '--stdio']);
      await client.initialize();
    },
    TEST_MS,
  );

  it(
    'survives a malformed document URI and still answers requests',
    async () => {
      const client = startServer(['--lsp']);
      await client.initialize();

      client.open('file:///C:/x/100%zz/CLAUDE.md', '# Project\n\n- See `src/missing.ts`\n');
      client.open('untitled:Untitled-1', '# x\n');

      // A request issued after the bad notifications is answered only if the
      // server is still alive and its message loop still running.
      const id = client.request('shutdown', null);
      const response = await client.waitFor((m) => m.id === id, 'shutdown response');
      expect(response.error).toBeUndefined();
      expect(client.exited).toBe(false);
    },
    TEST_MS,
  );
});
