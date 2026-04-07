// --mcp flag: launch the MCP server instead of the CLI linter
if (process.argv.includes('--mcp')) {
  await import('./mcp/server.js');
} else {
  // Dynamic import so MCP server deps aren't loaded for normal CLI usage
  const { runCli } = await import('./cli.js');
  await runCli();
}
