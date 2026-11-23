// Runs in every test worker before any test file loads.
//
// CLAUDE_CONFIG_DIR and CODEX_HOME outrank HOME / USERPROFILE when the session,
// transcript and skill scanners resolve the user's config dirs. A test that
// sandboxes a fake home by redirecting only HOME would otherwise read the REAL
// config dir whenever the shell running the suite exports either one (a Claude
// Code session exports CLAUDE_CONFIG_DIR). Children the tests spawn inherit
// this cleaned env. A test that needs either variable sets it itself.
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
