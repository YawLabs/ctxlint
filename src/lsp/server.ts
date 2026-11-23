import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  DiagnosticSeverity,
  DidChangeWatchedFilesNotification,
  TextDocumentSyncKind,
  type Diagnostic,
  type InitializeResult,
  type TextDocumentChangeEvent,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_CHECKS, runAuditOnContent } from '../core/audit.js';
import { resetPathsCache } from '../core/checks/paths.js';
import { loadConfig } from '../core/config.js';
import type { LintResult } from '../core/types.js';
import { resetPackageJsonCache } from '../utils/fs.js';
import { resetGit } from '../utils/git.js';

// A directory holding any of these is taken as the project root of a document
// outside every workspace folder (or when the client sent none).
const PROJECT_MARKERS = ['.ctxlintrc', '.ctxlintrc.json', 'package.json', '.git'];

/**
 * Map a document URI to a filesystem path, or null for anything that is not a
 * well-formed `file:` URI (untitled:, git:, a malformed percent-escape...).
 */
function uriToPath(uri: string): string | null {
  if (!uri.startsWith('file:')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function isWithin(dir: string, filePath: string): boolean {
  const rel = path.relative(dir, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The project root to audit `filePath` against: the innermost workspace folder
 * containing it, else the nearest ancestor directory holding a project marker,
 * else the file's own directory.
 */
function findProjectRoot(filePath: string, workspaceRoots: string[]): string {
  const containing = workspaceRoots
    .filter((root) => isWithin(root, filePath))
    .sort((a, b) => b.length - a.length);
  if (containing.length > 0) return containing[0];

  let dir = path.dirname(filePath);
  for (;;) {
    if (PROJECT_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.dirname(filePath);
    dir = parent;
  }
}

function toDiagnostics(result: LintResult): Diagnostic[] {
  return result.files.flatMap((fr) =>
    fr.issues.map((issue) => ({
      range: {
        start: { line: Math.max(0, issue.line - 1), character: 0 },
        end: { line: Math.max(0, issue.line - 1), character: 9999 },
      },
      severity:
        issue.severity === 'error'
          ? DiagnosticSeverity.Error
          : issue.severity === 'warning'
            ? DiagnosticSeverity.Warning
            : DiagnosticSeverity.Information,
      code: issue.ruleId ?? issue.check,
      source: 'ctxlint',
      message: issue.suggestion ? `${issue.message} -- ${issue.suggestion}` : issue.message,
    })),
  );
}

/** Quiet period after the last edit to a document before it is audited. */
export const AUDIT_DEBOUNCE_MS = 300;
/**
 * Upper bound on how long the project file list and git memo are reused when
 * no save, close or watched-file event says the project changed (a client
 * without file watching still notices a `git init` or new file eventually).
 */
export const CACHE_MAX_AGE_MS = 30_000;

export interface AuditScheduler {
  /** (Re)start `uri`'s debounce timer; its audit runs after the quiet period. */
  schedule(uri: string): void;
  /** Drop `uri`'s pending audit, if any (a closed document). */
  cancel(uri: string): void;
  /** The project changed on disk: the next audit must rebuild the caches. */
  invalidate(): void;
  /** Resolves once every audit queued so far has finished (tests). */
  idle(): Promise<void>;
}

/**
 * Debounce audits per URI and run them one at a time, in the order they
 * became due, so an older run can never publish after a newer one. The shared
 * caches (project file list, git probes, package.json) are kept across runs
 * and rebuilt only after invalidate() or once they are older than
 * `maxCacheAgeMs`: `run` receives `freshCaches: true` exactly then.
 */
export function createAuditScheduler(opts: {
  delayMs: number;
  maxCacheAgeMs: number;
  run: (uri: string, freshCaches: boolean) => Promise<void>;
  now?: () => number;
}): AuditScheduler {
  const now = opts.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let queue: Promise<void> = Promise.resolve();
  let stale = true;
  let builtAt = 0;

  const runOne = async (uri: string): Promise<void> => {
    const t = now();
    const fresh = stale || t - builtAt >= opts.maxCacheAgeMs;
    if (fresh) {
      stale = false;
      builtAt = t;
    }
    try {
      await opts.run(uri, fresh);
    } catch {
      // `run` owns its error reporting; a throw must not wedge the queue.
    }
  };

  return {
    schedule(uri) {
      clearTimeout(timers.get(uri));
      timers.set(
        uri,
        setTimeout(() => {
          timers.delete(uri);
          queue = queue.then(() => runOne(uri));
        }, opts.delayMs),
      );
    },
    cancel(uri) {
      clearTimeout(timers.get(uri));
      timers.delete(uri);
    },
    invalidate() {
      stale = true;
    },
    idle() {
      return queue;
    },
  };
}

/**
 * Start the ctxlint LSP server. Reads/writes JSON-RPC 2.0 messages over
 * process.stdin / process.stdout (stdio transport), with or without the
 * conventional `--stdio` flag. The server implements:
 *   - textDocument/didOpen
 *   - textDocument/didChange  (TextDocumentSyncKind.Full; audits debounced)
 *   - textDocument/didSave    (refreshes the project caches)
 *   - textDocument/didClose   (clears the document's diagnostics)
 *   - workspace/didChangeWatchedFiles (refreshes the project caches)
 *   - textDocument/publishDiagnostics
 */
export async function startLspServer(): Promise<void> {
  // Pass the streams explicitly: without them createConnection only finds a
  // transport when argv carries `--stdio` / `--node-ipc` / `--socket`, so a
  // plain `ctxlint --lsp` died with "Connection input stream is not set".
  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  let workspaceRoots: string[] = [];
  let canWatchFiles = false;

  connection.onInitialize((params): InitializeResult => {
    const uris =
      params.workspaceFolders?.map((f) => f.uri) ?? (params.rootUri ? [params.rootUri] : []);
    workspaceRoots = uris.map(uriToPath).filter((p): p is string => p !== null);
    canWatchFiles = !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;
    return {
      capabilities: {
        // `save` so the client sends didSave: a save is when the project on
        // disk changes, and invalidates the caches kept across keystrokes.
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Full,
          save: { includeText: false },
        },
      },
    };
  });

  connection.onInitialized(() => {
    if (!canWatchFiles) return;
    connection.client
      .register(DidChangeWatchedFilesNotification.type, { watchers: [{ globPattern: '**/*' }] })
      .catch(() => {
        // No watcher: save/close events and CACHE_MAX_AGE_MS still refresh.
      });
  });

  // Every keystroke re-audited the buffer against the real project root (a
  // full project walk plus git spawns, ~0.3-0.5 s) with no debounce, and the
  // runs overlapped. Debounce per document, run one audit at a time, and keep
  // the project file list, package.json and per-root git probes across
  // keystrokes: rebuild them only when the project changed (save, close, a
  // watched-file event) or they are older than CACHE_MAX_AGE_MS, so a
  // `git init` or an unshallow is still noticed.
  const scheduler = createAuditScheduler({
    delayMs: AUDIT_DEBOUNCE_MS,
    maxCacheAgeMs: CACHE_MAX_AGE_MS,
    run: async (uri, freshCaches) => {
      const doc = documents.get(uri);
      if (!doc) return;
      if (freshCaches) {
        resetGit();
        resetPathsCache();
        resetPackageJsonCache();
      }
      await validateDocument(doc);
    },
  });

  /**
   * Audit a document and push its diagnostics to the client. Never rejects.
   */
  async function validateDocument(doc: TextDocument): Promise<void> {
    const { uri, version } = doc;
    try {
      const filePath = uriToPath(uri);
      if (filePath === null) return;

      const projectRoot = findProjectRoot(filePath, workspaceRoots);
      let config: ReturnType<typeof loadConfig> = null;
      try {
        config = loadConfig(projectRoot);
      } catch {
        // A malformed .ctxlintrc must not take diagnostics down; use defaults.
      }
      const checks = (config?.checks ?? ALL_CHECKS).filter((c) => !config?.ignore?.includes(c));
      const result = await runAuditOnContent(filePath, doc.getText(), projectRoot, checks, {
        tokenThresholds: config?.tokenThresholds,
        ignoreRules: config?.ignoreRules,
        hooksGlobal: config?.hooksGlobal,
      });

      if (!isCurrent(doc, version)) return;
      await connection.sendDiagnostics({ uri, version, diagnostics: toDiagnostics(result) });
    } catch {
      // On any error clear diagnostics so stale results don't accumulate.
      if (!isCurrent(doc, version)) return;
      await connection.sendDiagnostics({ uri, version, diagnostics: [] }).catch(() => {});
    }
  }

  /**
   * True while `doc` is still the open buffer for its URI. A newer edit, a
   * close, or a close + reopen arrived while its audit ran: that buffer's own
   * audit owns the diagnostics now, so a slow older result must not land on
   * top. Both halves are needed: TextDocuments updates an open document IN
   * PLACE on each edit (same object, so `version` must be the value captured
   * when this audit started, not doc.version), and builds a new object on each
   * open -- clients reopen at version 1, so only identity separates a reopened
   * document from the closed one.
   */
  function isCurrent(doc: TextDocument, version: number): boolean {
    const live = documents.get(doc.uri);
    return live === doc && live.version === version;
  }

  // TextDocuments fires onDidChangeContent for the initial open as well as for
  // every edit, so this one handler audits each open exactly once; a separate
  // onDidOpen handler would audit every opened document twice.
  documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
    scheduler.schedule(change.document.uri);
  });

  documents.onDidSave(() => scheduler.invalidate());
  connection.onDidChangeWatchedFiles(() => scheduler.invalidate());

  documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
    scheduler.cancel(event.document.uri);
    scheduler.invalidate();
    if (uriToPath(event.document.uri) === null) return;
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }).catch(() => {});
  });

  documents.listen(connection);
  connection.listen();
}
