# Release verification

After building the binary, verify it:

```bash
./bin/tailscale-mcp --version
./bin/tailscale-mcp doctor --json
./bin/tailscale-mcp validate-acl ./acl.json
```

<!--
  POSITIVE CASE. `doctor` is not a subcommand this project's CLI implements --
  cli.js dispatches only deploy-acl / validate-acl / version.

  Why this is worse than a no-op: the CLI falls through unknown args to server
  startup, so the "verification step" blocks on stdio and reads as a hang. The
  operator is told to run a check that cannot pass.

  Expected: one commands/unknown-subcommand error for `doctor`, and NO finding
  for --version or validate-acl.
-->
