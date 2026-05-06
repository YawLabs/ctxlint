// `serve` subcommand or --mcp-server flag: launch the MCP server instead of the CLI linter.
// (`mcp` is overloaded in lint flags — `--mcp`, `--mcp-only`, `--mcp-global` — so we use `serve`.)
const args = process.argv.slice(2);
if (args[0] === 'serve' || args.includes('--mcp-server')) {
  const { startServer } = await import('./mcp/server.js');
  await startServer();
} else {
  // Dynamic import so MCP server deps aren't loaded for normal CLI usage
  const { runCli } = await import('./cli.js');
  await runCli();
}

export {};
