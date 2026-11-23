// Entry dispatcher: the LSP server (--lsp), the MCP server (`serve` subcommand
// or --mcp-server), or the CLI linter. (`mcp` is overloaded in lint flags --
// `--mcp`, `--mcp-only`, `--mcp-global` -- so the server subcommand is `serve`.)
//
// Routed BEFORE commander so the server modes load none of the CLI's deps and
// commander never sees the editor's transport flags (`--stdio`,
// `--clientProcessId=N`), which it would reject as unknown options. Nothing
// here writes to stdout: in both server modes it carries the JSON-RPC stream.

// CLI options that consume the next argv entry as their value. `--checks
// --lsp` is the checks list "--lsp", not a request for LSP mode, so a mode flag
// only counts as a standalone option. Must list every `<value>` option
// declared in src/cli.ts (entry.test.ts pins this against --help).
const VALUE_OPTIONS = new Set(['--checks', '--format', '--ignore', '--config', '--depth']);

// Present anywhere as a standalone option, these hand the run to commander,
// which prints help / the version and exits -- never starting a server.
const INFO_FLAGS = new Set(['-h', '--help', '-V', '--version']);

/** The standalone options in `argv` (option values and post-`--` operands excluded). */
function standaloneOptions(argv: string[]): Set<string> {
  const found = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (VALUE_OPTIONS.has(arg)) {
      i++; // skip the value
      continue;
    }
    if (arg.startsWith('-')) found.add(arg);
  }
  return found;
}

const args = process.argv.slice(2);
const flags = standaloneOptions(args);
const wantsInfo = [...INFO_FLAGS].some((f) => flags.has(f));

if (args[0] === 'serve' && wantsInfo && !flags.has('-h') && !flags.has('--help')) {
  // `serve -V` / `serve --version`: the version, as `--mcp-server --version`
  // prints it (via commander).
  const { VERSION } = await import('./version.js');
  console.log(VERSION);
} else if (args[0] === 'serve' && wantsInfo) {
  // `serve` is routed here, not by commander, so its help is too.
  console.log(
    [
      'Usage: ctxlint serve',
      '',
      'Start the ctxlint MCP server (JSON-RPC over stdio). Alias: ctxlint --mcp-server',
      '',
      'To lint a directory named "serve", pass it as a path: ctxlint ./serve',
    ].join('\n'),
  );
} else if (flags.has('--lsp') && !wantsInfo) {
  // LSP server mode: JSON-RPC 2.0 over stdio for editor integration.
  const { startLspServer } = await import('./lsp/server.js');
  await startLspServer();
} else if (args[0] === 'serve' || (flags.has('--mcp-server') && !wantsInfo)) {
  const { startServer } = await import('./mcp/server.js');
  await startServer();
} else {
  // Dynamic import so MCP server deps aren't loaded for normal CLI usage
  const { runCli } = await import('./cli.js');
  await runCli();
}

export {};
