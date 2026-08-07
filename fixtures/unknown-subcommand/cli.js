#!/usr/bin/env node
// Minimal argv dispatch in the shape the detector must read: string-literal
// comparisons against process.argv[2]. The known-subcommand set is
// {deploy-acl, validate-acl, version, --version}.
const subcommand = process.argv[2];

if (subcommand === "deploy-acl" || subcommand === "validate-acl") {
  console.log(`running ${subcommand}`);
  process.exit(0);
} else if (subcommand === "version" || subcommand === "--version") {
  console.log("1.0.0");
  process.exit(0);
} else if (subcommand !== undefined) {
  // Unknown args deliberately fall through to long-running server startup --
  // this is exactly why an unknown subcommand in the docs reads as a hang
  // rather than failing fast.
  console.error(`unrecognized argument "${subcommand}" -- starting server`);
}

setInterval(() => {}, 1 << 30);
