// --mcp-server flag: launch the MCP server instead of the CLI linter
if (process.argv.includes('--mcp-server')) {
  await import('./mcp/server.js');
} else {
  // Dynamic import so MCP server deps aren't loaded for normal CLI usage
  const { runCli } = await import('./cli.js');
  await runCli();
}
