import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  DiagnosticSeverity,
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

/**
 * Start the ctxlint LSP server. Reads/writes JSON-RPC 2.0 messages over
 * process.stdin / process.stdout (stdio transport), with or without the
 * conventional `--stdio` flag. The server implements:
 *   - textDocument/didOpen
 *   - textDocument/didChange  (TextDocumentSyncKind.Full)
 *   - textDocument/didClose   (clears the document's diagnostics)
 *   - textDocument/publishDiagnostics
 */
export async function startLspServer(): Promise<void> {
  // Pass the streams explicitly: without them createConnection only finds a
  // transport when argv carries `--stdio` / `--node-ipc` / `--socket`, so a
  // plain `ctxlint --lsp` died with "Connection input stream is not set".
  const connection = createConnection(ProposedFeatures.all, process.stdin, process.stdout);
  const documents = new TextDocuments(TextDocument);
  let workspaceRoots: string[] = [];

  connection.onInitialize((params): InitializeResult => {
    const uris =
      params.workspaceFolders?.map((f) => f.uri) ?? (params.rootUri ? [params.rootUri] : []);
    workspaceRoots = uris.map(uriToPath).filter((p): p is string => p !== null);
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
      },
    };
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
      // Same per-call reset as the MCP server: this process is long-lived, so
      // the project file list, package.json and the per-root git probes
      // (isGitRepo / isShallowRepo) must be re-read every audit -- otherwise a
      // `git init` or an unshallow after the first open is never noticed.
      resetGit();
      resetPathsCache();
      resetPackageJsonCache();
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
    void validateDocument(change.document);
  });

  documents.onDidClose((event: TextDocumentChangeEvent<TextDocument>) => {
    if (uriToPath(event.document.uri) === null) return;
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }).catch(() => {});
  });

  documents.listen(connection);
  connection.listen();
}
