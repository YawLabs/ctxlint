import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  DiagnosticSeverity,
  TextDocumentSyncKind,
  type InitializeResult,
  type TextDocumentChangeEvent,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import * as path from 'node:path';
import { runAuditOnContent } from '../core/audit.js';
import { ALL_CHECKS } from '../core/audit.js';

/**
 * Start the ctxlint LSP server. Reads/writes JSON-RPC 2.0 messages over
 * process.stdin / process.stdout (stdio transport). The server implements:
 *   - textDocument/didOpen
 *   - textDocument/didChange  (TextDocumentSyncKind.Full)
 *   - textDocument/publishDiagnostics
 */
export async function startLspServer(): Promise<void> {
  const connection = createConnection(ProposedFeatures.all);
  const documents = new TextDocuments(TextDocument);

  connection.onInitialize((_params): InitializeResult => {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
      },
    };
  });

  /**
   * Validate a document and push diagnostics to the client.
   */
  async function validateDocument(doc: TextDocument): Promise<void> {
    const uri = doc.uri;

    // Convert file:// URI to an absolute filesystem path.
    // On Windows, file:///C:/foo -- strip the leading slash after decoding.
    let filePath = uri.startsWith('file://') ? decodeURIComponent(uri.slice(7)) : uri;
    // file:///C:/... -> /C:/... -- remove the leading slash on Windows drive paths.
    filePath = filePath.replace(/^\/([A-Za-z]:)/, '$1');

    const projectRoot = path.dirname(filePath);

    try {
      const result = await runAuditOnContent(filePath, doc.getText(), projectRoot, {
        depth: 2,
      });

      // Flatten all issues across all file buckets into LSP Diagnostics.
      const diagnostics = result.files.flatMap((fr) =>
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
          message: issue.suggestion
            ? `${issue.message} -- ${issue.suggestion}`
            : issue.message,
        })),
      );

      connection.sendDiagnostics({ uri, diagnostics });
    } catch {
      // On any error clear diagnostics so stale results don't accumulate.
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  }

  documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
    validateDocument(change.document);
  });

  documents.onDidOpen((event: TextDocumentChangeEvent<TextDocument>) => {
    validateDocument(event.document);
  });

  documents.listen(connection);
  connection.listen();
}
