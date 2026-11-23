#!/bin/bash
# =============================================================================
# ctxlint Release Script — Build, tag, publish to npm
# =============================================================================
# Usage:
#   ./release.sh <new-version>    — full release from this machine, on main
#
# There is no CI variant: this repo runs no CI (entry.test.ts asserts there are no
# workflows), and this script is the only publisher.
#
# If interrupted, re-run with the same version: a run that finds package.json
# already at it resumes, and steps 5-8 each skip what already landed (the
# commit, the tag, the npm version, the GitHub release, the registry entry).
# A resume still re-runs the gates of steps 1-3, so when only step 8's registry
# publish failed, its failure message names the one command that finishes the
# release without them.
#
# Prerequisites (pre-flight checks each before anything is touched):
#   - Node.js 20+, pnpm, npm, jq, gh and curl on PATH
#   - npm authenticated (npm whoami)
#   - gh CLI authenticated (gh auth status)
#   - on main, with origin/main not ahead of it
# =============================================================================

set -euo pipefail
trap 'echo -e "\n\033[0;31m  ✗ Release failed at line $LINENO (exit code $?)\033[0m"' ERR

# ---- Helpers ----
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

step() { echo -e "\n${CYAN}=== [$1/$TOTAL_STEPS] $2 ===${NC}"; }
info() { echo -e "${GREEN}  ✓ $1${NC}"; }
warn() { echo -e "${YELLOW}  ! $1${NC}"; }
fail() { echo -e "${RED}  ✗ $1${NC}"; exit 1; }

# --- CHANGELOG promotion -------------------------------------------------
# Every release gets a `## [<version>] - <today>` entry, written in step 4
# beside the version bump, and step 7 takes the GitHub release notes from it.
#
# The promotion used to skip any release with nothing under [Unreleased], and
# step 7 then built the release notes from commit subjects, so a docs-only
# release (v0.26.0) went out with a subject list for a release page and would
# have had no changelog entry at all had it not been written by hand. Now:
#   * [Unreleased] has content -> it becomes the version section, and a fresh,
#     empty [Unreleased] heading is left above it for the next change.
#   * [Unreleased] is empty or absent -> a version section is generated from
#     the commit subjects since the previous tag. Raw subjects are less than a
#     hand-written entry, but a version with no entry at all reads as a mistake.
#
# CHANGELOG.md is required (pre-flight checks it), so none of these helpers has
# a no-changelog branch.
#
# Step 1's gate and step 7's release-notes lookup have to agree on what counts
# as "an entry for this version". Two copies of this awk is exactly how a gate
# passes and its consumer then finds nothing, so the extraction lives here once.
# Prints the body of `## [<heading>]` up to the next `## [` heading.
changelog_section() {
  awk -v heading="$1" '
    index($0, "## [" heading "]") == 1 { capture=1; next }
    capture && /^## \[/ { exit }
    capture { print }
  ' CHANGELOG.md
}

# True when a section body carries any non-whitespace content.
changelog_nonempty() { [ -n "$(echo "$1" | tr -d '[:space:]')" ]; }

# Reuse whatever separator this file already puts between version and date.
# This file has used "-" since 0.12.0 and an em-dash before that; promoting
# with a hardcoded one would introduce a third style the day the first changes.
changelog_dash() {
  local d
  d=$(sed -nE 's/^## \[[0-9][^]]*\][[:space:]]+([^[:space:]]+)[[:space:]]+[0-9]{4}-[0-9]{2}-[0-9]{2}.*/\1/p' CHANGELOG.md 2>/dev/null | head -1)
  if [ -n "$d" ]; then printf '%s' "$d"; else printf '%s' '-'; fi
}

# The tag this release is compared against: the newest v* tag reachable from
# HEAD other than this release's own (a re-run after tagging must not compare
# the version with itself). Empty on a first release.
changelog_prev_tag() {
  git describe --tags --abbrev=0 --match 'v*' --exclude "v${VERSION}" 2>/dev/null || true
}

# The body of a generated entry: one bullet per commit subject since the
# previous tag, newest first, with version-bump commits dropped. The blank line
# under the heading is prettier's markdown style: without it the entry, written
# after step 3's `prettier --check .`, failed the NEXT release's test run.
changelog_generated_body() {
  local prev=$1 range subjects
  if [ -n "$prev" ]; then range="${prev}..HEAD"; else range="HEAD"; fi
  subjects=$(git log --no-merges --format='%s' "$range" 2>/dev/null \
    | grep -vE '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^/- /' || true)
  [ -n "$subjects" ] || subjects="- Maintenance release; no changes since ${prev:-the previous release}."
  printf '### Changed\n\n%s\n' "$subjects"
}

# Make sure `## [<version>] - <today>` exists: promote [Unreleased] when it has
# content, otherwise generate the section from the commit subjects. The version
# and the date are both things the script already knows, so this is the same
# kind of mechanical version stamp as the package.json bump -- there is no
# reason to make the human do it by hand and then abort the release when they
# forget. Every release promoting its own heading is also what stops
# [Unreleased] from silently accumulating across several tags, which is how
# v0.18.3 through v0.18.7 all shipped with no sections of their own.
#
# Idempotent: an entry for this version already existing (a resume, or the
# author promoted by hand) is left as it is.
promote_changelog() {
  if changelog_nonempty "$(changelog_section "$VERSION")"; then
    info "CHANGELOG.md already has an entry for v${VERSION}"
    return 0
  fi
  local prev today tmp dash heading body
  prev=$(changelog_prev_tag)
  today=$(date +%F)
  dash=$(changelog_dash)
  heading="## [${VERSION}] ${dash} ${today}"
  tmp=$(mktemp)
  if changelog_nonempty "$(changelog_section "Unreleased")"; then
    # Rewrite only the FIRST [Unreleased] heading: a stray later mention (a link
    # reference, a quoted example in the versioning-policy section) must not be
    # rewritten into a second, bogus version heading.
    awk -v repl="$heading" '
      !promoted && index($0, "## [Unreleased]") == 1 { print "## [Unreleased]"; print ""; print repl; promoted=1; next }
      { print }
    ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md promotion failed"; }
    info "CHANGELOG.md: promoted [Unreleased] -> [${VERSION}] ${dash} ${today}"
  else
    body=$(changelog_generated_body "$prev")
    warn "CHANGELOG.md has no [Unreleased] content -- writing [${VERSION}] from the commit subjects since ${prev:-the first commit}; edit it if they undersell the release"
    # Insert below an empty [Unreleased] heading, else above the first version
    # heading, else at the end of the file.
    awk -v heading="$heading" -v body="$body" '
      !done && index($0, "## [Unreleased]") == 1 { print; print ""; print heading; print ""; print body; done=1; next }
      !done && /^## \[/ { print heading; print ""; print body; print ""; done=1 }
      { print }
      END { if (!done) { print ""; print heading; print ""; print body } }
    ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md entry generation failed"; }
    info "CHANGELOG.md: added [${VERSION}] ${dash} ${today} from commit subjects"
  fi
  mv "$tmp" CHANGELOG.md
}

# Backstop for the promotion above: every release has an entry now, so a
# missing one means promote_changelog did not run or did not land, and step 7
# would publish a GitHub release with empty notes.
assert_changelog_promoted() {
  changelog_nonempty "$(changelog_section "$VERSION")" && return 0
  fail "CHANGELOG.md has no '## [${VERSION}]' entry. Step 4 should have written it -- promote_changelog did not run or did not land."
}

# Release notes for step 7: the version's changelog section, trimmed of the
# blank lines around it. assert_changelog_promoted runs first, so it is never
# empty.
release_notes() {
  changelog_section "$VERSION" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}'
}
# --- end CHANGELOG helpers ---

# ---- Release-written files ----
# Every file a release run writes and step 5 commits: the version bump and its
# lockfile, the synced version pins (sync_version_files), the compliance badge
# step 3 regenerates, server.json, and the CHANGELOG entry step 4 writes. One
# list, so the resume check in pre-flight, the prettier check after step 4 and
# the commit in step 5 cannot disagree about it.
RELEASE_FILES=(package.json pnpm-lock.yaml .pre-commit-hooks.yaml README.md compliance-badge.svg server.json CHANGELOG.md)

# `git status --porcelain` for every change OUTSIDE RELEASE_FILES, untracked
# files included. Empty means the tree holds nothing but an earlier run's own
# writes -- the one dirt a resume may carry, since anything else would be
# published under a tag whose commit lacks it.
dirty_outside_release_files() {
  local excludes=() f
  for f in "${RELEASE_FILES[@]}"; do excludes+=(":(exclude)$f"); done
  git status --porcelain -- . "${excludes[@]}"
}
# ---- end release-written files ----

# ---- Version-pinned files ----
# Every file besides package.json that names the release being cut. Both syncs
# are idempotent: already at $VERSION, they write nothing.
#
# - scripts/sync-version-refs.mjs: the .pre-commit-hooks.yaml npx entry (so
#   `rev: vX.Y.Z` runs exactly that release rather than whatever @latest was at
#   install time), plus README.md's pre-commit `rev:` and example-output
#   banner, which went unsynced from v0.9.10 until a hand bump to v0.25.0
#   (#63). It fails, writing nothing, when any pattern is missing.
# - server.json: published to the MCP Registry in step 8 and must match the
#   tag's version, or mcp-publisher re-publishes the previous version and gets
#   400 "cannot publish duplicate version".
#
# Step 4 runs this after the package.json bump. A RESUME also runs it at the
# end of pre-flight, after the confirmation and before step 1: when an earlier
# run bumped package.json and then died before these syncs finished, step 3's
# tests (server.json and the pins in entry.test.ts, and version-refs.test.ts
# --check) fail on that half-bumped tree, so a resume that waited for step 4
# would never get there.
sync_version_files() {
  node scripts/sync-version-refs.mjs "$VERSION" || fail "Pinned version refs not synced to $VERSION -- see the error above"

  if [ -f server.json ]; then
    local current_server_version
    current_server_version=$(jq -r '.version' server.json 2>/dev/null || echo "")
    if [ "$current_server_version" != "$VERSION" ]; then
      # tr: a native Windows jq.exe writes CRLF (jq 1.7.1, measured 2026-09-13).
      # git normalizes the committed blob, but the working-tree file stays CRLF
      # and fails the NEXT release's step 3, whose `prettier --check .` expects LF.
      # Explicit handlers, as in promote_changelog: the ERR trap's "Release failed
      # at line N" banner does not fire inside a function (no `set -E`).
      jq --arg v "$VERSION" '.version = $v | .packages[0].version = $v' server.json | tr -d '\r' > server.tmp \
        || { rm -f server.tmp; fail "server.json sync to $VERSION failed -- see the error above"; }
      mv server.tmp server.json || fail "Could not replace server.json"
      # jq re-serialises the whole file in its own layout (an inline array
      # comes back one element per line), which prettier then rejects. Put it
      # back in the repo's format rather than depend on the two agreeing.
      npx prettier --write server.json >/dev/null || fail "prettier could not format server.json"
      info "server.json synced to $VERSION"
    fi
  fi
}

# SKIP_LINT=1 escape hatch -- step 1 skips `pnpm run lint` (package.json `lint`,
# eslint) and nothing else: typecheck, tests and the build still run.
#
# It does NOT route around a broken runner, and the name is inherited rather
# than earned. Lint here is eslint: pure JS on node, with no native binary to
# crash, and it exits 0 on MINGW64-ARM64 (measured 2026-09-11). The crash the
# hatch is named after belongs to a sibling repo's toolchain -- biome's native
# win32-arm64 executable, which dies on CHECK-shaped runs at SOME versions
# (2.5.4 does, while answering `--version` with exit 0; 2.4.16 and 2.5.13 run
# correctly -- measured 2026-09-11 on this host). This repo does not depend on
# biome at all, so none of that can happen here.
#
# So setting this skips a WORKING gate, and nothing re-checks it afterwards:
# there is no CI -- `.github/` holds only CODEOWNERS, no `workflows/` directory
# exists, and `gh api repos/YawLabs/ctxlint/actions/permissions --jq .enabled`
# returns false (checked 2026-09-11), so Actions could not run a workflow even
# if one were added. This script is the only thing that ever runs eslint on
# this code. What SKIP_LINT really buys is a release whose lint findings were
# never looked at. Explicit last resort only, and needing it is a bug to fix
# rather than a step to skip.

TOTAL_STEPS=9

# ---- Resolve version ----
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./release.sh <version>"
  echo "  e.g. ./release.sh 0.6.0"
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
# Everything a later step needs is checked here, before anything is written: a
# jq missing at step 4, an npm token missing at step 6 or a gh login missing at
# step 7 used to surface only after the bump, the tag push, or the publish.
echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null  || fail "node not installed"
command -v pnpm >/dev/null  || fail "pnpm not installed"
command -v npm >/dev/null   || fail "npm not installed"
command -v jq >/dev/null    || fail "jq not installed (step 4 syncs server.json with it)"
command -v gh >/dev/null    || fail "gh not installed (step 7 creates the GitHub release with it)"
command -v curl >/dev/null  || fail "curl not installed (steps 6-9 read the npm registry with it)"
[ -f CHANGELOG.md ]         || fail "CHANGELOG.md is missing -- step 4 writes the release entry there and step 7 takes the notes from it"

npm whoami >/dev/null 2>&1 \
  || fail "npm is not authenticated ('npm whoami' failed). The automation token in ~/.npmrc is missing or stale: restore it (the //registry.npmjs.org/:_authToken line). Do NOT re-auth via the web login flow -- it overwrites the automation token with a 2FA-bound session."
gh auth status >/dev/null 2>&1 || fail "gh is not authenticated ('gh auth status' failed) -- step 7 and the MCP Registry login in step 8 need it"
info "Tools and logins: node, pnpm, npm (authenticated), jq, gh (authenticated), curl"

# The release commit is pushed to origin's main, so it has to be made on main
# and on top of origin/main: on a branch behind it the push of main is
# rejected, after the commit and the tag already exist locally.
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  fail "On branch '$BRANCH' -- releases are cut from main. git switch main first."
fi
git fetch --quiet origin main || fail "git fetch origin main failed -- cannot tell whether main is behind origin"
CURRENT_VERSION=$(node -p "require('./package.json').version")
BEHIND=$(git rev-list --count HEAD..origin/main)
if [ "$BEHIND" != "0" ]; then
  # A resume whose tag already reached origin must not be told to pull: a pull
  # moves HEAD off the tag, and steps 6-8 would then publish a dist built from
  # commits the tag does not contain (step 5 refuses that too, but only after
  # the gates have run again).
  if [ "$CURRENT_VERSION" = "$VERSION" ] \
    && git ls-remote --exit-code --tags origin "refs/tags/v${VERSION}" >/dev/null 2>&1; then
    fail "main is $BEHIND commit(s) behind origin/main, and v${VERSION} is already on origin. Do NOT pull: the steps left must publish exactly the tagged commit, and a pull moves HEAD off it. This run cannot finish from main as it stands (step 5's push of main would be rejected); finish the remaining steps (npm publish, GitHub release, MCP Registry) from a checkout of v${VERSION}."
  fi
  fail "main is $BEHIND commit(s) behind origin/main -- pull (and re-test) before releasing."
fi
info "On main, not behind origin/main"

RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  # A resume may find an earlier run's own writes in the tree, and only those:
  # any other change would be published under a tag whose commit lacks it.
  DIRT=$(dirty_outside_release_files)
  if [ -n "$DIRT" ]; then
    printf '%s\n' "$DIRT"
    fail "Resuming v${VERSION}, but the files above are changed and are not ones a release writes. Commit or stash them first."
  fi
  info "Already at v${VERSION} — resuming"
else
  if [ -n "$(git status --porcelain)" ]; then
    fail "Working directory not clean. Commit or stash changes first."
  fi
  info "Current: v${CURRENT_VERSION} → v${VERSION}"
fi

echo ""
if [ "$RESUMING" = "true" ]; then
  echo -e "${YELLOW}About to RESUME v${VERSION} -- each step skips what already landed. This will:${NC}"
else
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
fi
echo "  1. Lint & type-check"
echo "  2. Build"
echo "  3. Test, oam and Yaw MCP floors, MCP compliance"
echo "  4. Bump version in package.json"
echo "  5. Commit, tag, and push"
echo "  6. Publish to npm"
echo "  7. Create GitHub release"
echo "  8. Publish to MCP Registry"
echo "  9. Verify"
echo ""
if [ -t 0 ]; then
  read -p "Continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
  fi
else
  info "Non-interactive shell -- proceeding without confirmation"
fi

# Before step 3, whose tests fail on a half-bumped resume. See sync_version_files.
if [ "$RESUMING" = "true" ]; then
  sync_version_files
fi

# =============================================================================
# Step 1: Lint & type-check
# =============================================================================
step 1 "Lint & type-check"

# Say up front which release notes this run will publish. Purely informational
# -- step 4 writes the [${VERSION}] entry itself, so an unpromoted CHANGELOG is
# not a failure here and must not abort: aborting would block the script from
# doing the one mechanical edit it is perfectly capable of making.
if changelog_nonempty "$(changelog_section "$VERSION")"; then
  info "Release notes: existing CHANGELOG.md entry for v${VERSION}"
elif changelog_nonempty "$(changelog_section "Unreleased")"; then
  info "Release notes: [Unreleased] section, which step 4 will promote to [${VERSION}]"
else
  warn "Release notes: no CHANGELOG.md entry and no [Unreleased] content -- step 4 will write [${VERSION}] from the commit subjects since the previous tag"
fi

# A crashed linter is not a lint result -- and it is not a pass either. Lint
# here is eslint: pure JS on node, with no native binary to segfault, and it
# exits 0 on MINGW64-ARM64 (measured 2026-09-11). So a crash from this command
# is not a known platform quirk to wave through; it means no verdict was
# produced. A crash shows up two ways: bash reports a SIGSEGV as 139 (128+11,
# which is also how MSYS bash reports a native Windows process dying with
# STATUS_ACCESS_VIOLATION), and pnpm, when it is the CHILD that crashed, exits
# 1 itself and prints the child's raw status -- 3221225477 (0xC0000005) on
# Windows. A bash exit status is 0-255, so that number can only be matched in
# the output, never in $?. Nothing downstream re-checks it either -- there is no
# CI (no .github/workflows, and GitHub Actions is disabled on the repo) -- so
# continuing would publish on a gate that never ran. It fails the release.
#
# The output is still captured to a file rather than streamed, so that a crash
# cannot masquerade as "lint found problems" under `set -euo pipefail`; the
# captured text is printed before failing, whichever way the run failed.
LINT_OUT=$(mktemp)
if [ "${SKIP_LINT:-}" = "1" ]; then
  warn "Lint SKIPPED (SKIP_LINT=1) -- UNVERIFIED for this release, and there is no CI that will re-check it"
elif pnpm run lint > "$LINT_OUT" 2>&1; then
  info "Lint passed"
else
  LINT_RC=$?
  cat "$LINT_OUT"
  LINT_CRASHED=false
  if [ "$LINT_RC" -eq 139 ] || grep -qE '3221225477|STATUS_ACCESS_VIOLATION|Segmentation fault' "$LINT_OUT"; then
    LINT_CRASHED=true
  fi
  rm -f "$LINT_OUT"
  if [ "$LINT_CRASHED" = "true" ]; then
    fail "Lint runner CRASHED (exit $LINT_RC) -- no lint verdict was produced, so the release stops here. eslint is pure JS and is not expected to crash on this platform, so investigate rather than skip. As an explicit last resort, SKIP_LINT=1 ./release.sh ${VERSION} releases with lint unverified -- and there is no CI to catch what that misses."
  fi
  fail "Lint failed (exit $LINT_RC)"
fi
rm -f "$LINT_OUT"

# Type-check. Previously a distinct step in the (now removed) GitHub Actions
# ci.yml / release.yml -- release.sh is the sole quality gate now, so it runs
# here. Invoked as `npx tsc` (not `pnpm run`) so the MINGW64-ARM `pnpm run`
# exit-segfault (platform-windows.md) cannot touch it. The second run covers
# the plain-JS files tsconfig.json does not: bin/ctxlint.mjs -- which ships --
# scripts/ and build.mjs (checkJs; see tsconfig.scripts.json).
npx tsc --noEmit
npx tsc -p tsconfig.scripts.json
info "Type-check passed (src/, plus bin/, scripts/ and build.mjs)"

# =============================================================================
# Step 2: Build
# =============================================================================
step 2 "Build"

pnpm run build
info "Build complete"

# =============================================================================
# Step 3: Test
# =============================================================================
step 3 "Test, oam and Yaw MCP floors, MCP compliance"

pnpm run test:run
info "All tests passed"

# ---- oam floor ----
# Two halves. check-oam-floor.mjs keeps OAM_MIN consistent across the repo
# (its offline half also runs in the suite above, through oam-floor.test.ts)
# and, online, not behind the latest oam release. verify-oam-floor.mjs hosts
# `bin/ctxlint.mjs serve` through `oam run` on THIS machine's oam and completes
# initialize + tools/list -- oam's own sidecar matrix runs ctxlint only on oam's
# release cadence, so this is the check on ctxlint's. Neither may pass
# silently when it could not look: an unreachable GitHub API and a machine
# with no oam are both warnings, never a quiet green.
FLOOR_OUT=$(node scripts/check-oam-floor.mjs 2>&1) || {
  printf '%s\n' "$FLOOR_OUT"
  fail "oam floor check failed -- see above. Set CTXLINT_ALLOW_STALE_OAM=1 to release on the old floor deliberately."
}
printf '%s\n' "$FLOOR_OUT"
# check-oam-floor.mjs passes a stale floor only under CTXLINT_ALLOW_STALE_OAM=1,
# and then still prints its STALE: line -- this must not call that floor current.
if grep -q '^STALE:' <<< "$FLOOR_OUT"; then
  warn "oam floor is BEHIND the latest oam release -- releasing on it anyway because CTXLINT_ALLOW_STALE_OAM=1"
elif grep -q "staleness not checked" <<< "$FLOOR_OUT"; then
  warn "oam floor staleness NOT checked (GitHub API unreachable) -- the floor may be behind the latest oam release"
else
  info "oam floor consistent and current"
fi

VERIFY_OUT=$(node scripts/verify-oam-floor.mjs 2>&1) || {
  printf '%s\n' "$VERIFY_OUT"
  fail "oam floor verification failed -- see above."
}
printf '%s\n' "$VERIFY_OUT"
if grep -q "\[verify:oam-floor\] SKIP" <<< "$VERIFY_OUT"; then
  warn "oam handshake NOT verified on this machine -- ctxlint ships on the oam floor unchecked by this release"
else
  info "oam hosts ctxlint serve (initialize + tools/list)"
fi

# ---- Yaw MCP floor ----
# Drift (YAW_MCP_MIN vs the README claim and the @yawlabs/mcp-compliance
# devDependency) fails the release, and the suite above already ran that half
# (yaw-mcp-floor.test.ts). A newer @yawlabs/mcp on npm is only a WARNING --
# nothing at runtime reads this floor -- so it prints and the release
# continues. Offline it says so and passes.
YAW_FLOOR_OUT=$(node scripts/check-yaw-mcp-floor.mjs 2>&1) || {
  printf '%s\n' "$YAW_FLOOR_OUT"
  fail "Yaw MCP floor drift -- see above."
}
printf '%s\n' "$YAW_FLOOR_OUT"
if grep -q "WARNING" <<< "$YAW_FLOOR_OUT"; then
  warn "Yaw MCP floor is behind the latest @yawlabs/mcp -- continuing"
else
  info "Yaw MCP floor has no drift"
fi

# ---- MCP compliance ----
# Grade the server with @yawlabs/mcp-compliance, pinned in devDependencies to
# the version line Yaw MCP grades with, and rewrite compliance-badge.svg from
# that run (step 5 commits it with the bump). Yaw MCP caches a grade per
# namespace and can refuse to spawn a server below YAW_MCP_MIN_COMPLIANCE, so a
# release that changes tool shapes should not go out on a stale grade. --strict
# and --min-grade A fail the release on any required failure or a grade below A.
# The run is local stdio and needs no network; a missing install and any
# skipped test are warnings, never a silent pass.
MCPC=node_modules/.bin/mcp-compliance
if [ ! -x "$MCPC" ]; then
  warn "mcp-compliance is not installed (pnpm install) -- compliance NOT graded, badge NOT refreshed"
else
  COMPLIANCE_JSON=$(mktemp)
  if "$MCPC" test --format json --strict --min-grade A --output compliance-badge.svg \
      node dist/index.js serve > "$COMPLIANCE_JSON"; then
    COMPLIANCE_SUMMARY=$(node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const s = r.summary || {};
      console.log(`grade ${r.grade} (${r.score}%), ${s.passed}/${s.total} passed, ${s.skipped || 0} skipped, ${(r.warnings || []).length} warning(s), mcp-compliance ${r.toolVersion}`);
      for (const w of r.warnings || []) console.log(`WARN ${w}`);
      if (s.skipped) console.log("SKIPPED");
    ' "$COMPLIANCE_JSON")
    rm -f "$COMPLIANCE_JSON"
    info "MCP compliance: ${COMPLIANCE_SUMMARY%%$'\n'*}"
    (grep '^WARN ' <<< "$COMPLIANCE_SUMMARY" || true) | sed 's/^WARN /    /'
    if grep -q "^SKIPPED" <<< "$COMPLIANCE_SUMMARY"; then
      warn "some compliance tests were skipped (capability-gated) -- they did not grade this release"
    fi
  else
    cat "$COMPLIANCE_JSON"
    rm -f "$COMPLIANCE_JSON"
    fail "MCP compliance below grade A or a required test failed -- see above."
  fi
fi

# =============================================================================
# Step 4: Bump version
# =============================================================================
step 4 "Bump version to $VERSION"

# Re-read at this step boundary rather than trusting the pre-flight value:
# steps 1-3 run for minutes, and package.json is mutable state.
CURRENT_VERSION=$(node -p "require('./package.json').version")
if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  info "Already at v${VERSION} — skipping"
else
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'));
    pkg.version = '$VERSION';
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  "
  pnpm install --lockfile-only 2>/dev/null || true
  info "Version bumped"
fi

# Unconditional (not inside the bump else above), so the bump branch holds
# nothing a resume would need to redo. See sync_version_files for why a resume
# also runs it before step 1.
sync_version_files

# Same unconditional placement as sync_version_files above, for the same reason:
# a resume run has CURRENT_VERSION == VERSION and skips the bump branch, but an
# unpromoted CHANGELOG still needs promoting. That is exactly the state v0.20.0
# was in when it failed -- the tag and the npm publish had already landed, and
# the resume could not fix the heading because the promotion lived nowhere.
promote_changelog
# Fail here, before anything is committed or tagged, if the entry still did
# not land; the step-7 copy of this check guards the notes on a re-entered run.
assert_changelog_promoted

# Step 3's `prettier --check .` ran before this step wrote anything, so check
# what it wrote now: a file prettier would rewrite, committed here, fails the
# NEXT release's test run instead (how a generated CHANGELOG entry once did).
# pnpm-lock.yaml is prettier-ignored and compliance-badge.svg is no prettier
# format, so neither is passed.
npx prettier --check package.json CHANGELOG.md README.md .pre-commit-hooks.yaml server.json \
  || fail "prettier rejects a file step 4 wrote -- see above. Nothing is committed yet; fix it, then re-run ./release.sh ${VERSION}."

# Rebuild AFTER the bump: build.mjs bakes package.json's version into the
# bundle (the __VERSION__ define), so the step-2 dist -- built while
# package.json still held the PREVIOUS version -- carries that old version.
# Publishing it is exactly how v0.22.0 shipped a dist whose --version
# reported 0.21.0. Step 2 stays as the fail-early gate; THIS build produces
# the artifact that ships. Unconditional so a resume run (which skips the
# bump branch) also gets a dist that matches package.json. dist/ is
# gitignored, so the rebuild leaves no working-tree dirt for step 5.
pnpm run build
info "Rebuilt dist with v${VERSION} baked"

# =============================================================================
# Step 5: Commit, tag, and push
# =============================================================================
step 5 "Commit, tag, and push"

# Commit the release's own writes, and only those: RELEASE_FILES that exist.
BUMP_FILES=()
for f in "${RELEASE_FILES[@]}"; do
  if [ -e "$f" ]; then BUMP_FILES+=("$f"); fi
done
if [ -n "$(git status --porcelain -- "${BUMP_FILES[@]}" 2>/dev/null)" ]; then
  git add -- "${BUMP_FILES[@]}"
  git commit -m "v${VERSION}"
  info "Committed version bump"
else
  info "Nothing to commit"
fi

# Tag if not already tagged. An existing tag (a resume) must point at HEAD:
# steps 6-8 publish the dist built from HEAD, so a tag left behind on an older
# commit -- HEAD moved by a pull, a rebase or a new commit since the earlier
# run tagged -- would put commits on npm that the tag does not contain.
if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  TAG_COMMIT=$(git rev-parse "v${VERSION}^{commit}")
  HEAD_COMMIT=$(git rev-parse HEAD)
  if [ "$TAG_COMMIT" != "$HEAD_COMMIT" ]; then
    fail "Tag v${VERSION} points at $TAG_COMMIT but HEAD is $HEAD_COMMIT -- the dist would be built from commits the tag does not contain. If the tag is not on origin yet, delete it (git tag -d v${VERSION}) and re-run to tag HEAD; if it is, do not move it: finish the release from a checkout of v${VERSION}."
  fi
  info "Tag v${VERSION} already exists at HEAD"
else
  git tag -a "v${VERSION}" -m "v${VERSION}"
  info "Tag v${VERSION} created"
fi

# Push
# Tag-drift safety: refuse to push if origin already has a tag at this name
# pointing to a different commit (rewound tag elsewhere, parallel release race).
# The push below would be rejected for it anyway, but this names both SHAs, and
# a release linked to origin's stale tag while npm carries the new commit is
# the failure it exists to rule out.
#
# A failed read is handled rather than left to `set -e`: at this point the
# commit and the tag exist locally, and "Release failed at line N" said
# nothing about that.
if ! ORIGIN_TAGS=$(git ls-remote --tags origin "refs/tags/v${VERSION}"); then
  fail "Could not read tags from origin (git ls-remote failed -- see above). LANDED LOCALLY ONLY: the v${VERSION} commit and tag; nothing is pushed or published. Re-run ./release.sh ${VERSION} once origin is reachable."
fi
ORIGIN_TAG_SHA=$(awk '{print $1}' <<< "$ORIGIN_TAGS")
if [ -n "$ORIGIN_TAG_SHA" ]; then
  LOCAL_TAG_SHA=$(git rev-parse "v${VERSION}")
  if [ "$ORIGIN_TAG_SHA" != "$LOCAL_TAG_SHA" ]; then
    fail "Tag v${VERSION} exists on origin at $ORIGIN_TAG_SHA but local tag points to $LOCAL_TAG_SHA -- resolve the drift before re-running"
  fi
fi

# --atomic, and this one tag by name: either main and v${VERSION} both land or
# neither does. `git push origin main --tags` was neither -- an origin/main
# ahead of this one rejected main while the tag still landed, and every stray
# local tag went up with it.
git push --atomic origin main "refs/tags/v${VERSION}" \
  || fail "git push failed -- see above. --atomic, so origin has neither main nor the tag from this push. LANDED LOCALLY ONLY: the v${VERSION} commit and tag. Fix the cause (git pull --rebase if main moved, then re-tag), then re-run ./release.sh ${VERSION}."
info "Pushed main and v${VERSION} to origin"

# =============================================================================
# True when the npm registry ITSELF serves this version: a 200 from the
# per-version document, the exact URL the MCP Registry's npm validator fetches.
# Used by step 6's "already published -- skipping" check, by step 8's gate
# before registering, and by step 9.
#
# Deliberately NOT `npm view`: that reads the whole packument, which
# registry.npmjs.org serves from Cloudflare's edge for up to 300s
# (Cache-Control: public, max-age=300; measured 2026-09-28 still HIT with
# no-cache request headers). npm's own `view` already revalidates, so the
# staleness is the CDN edge, not npm's disk cache -- it is what the v0.25.0 run
# measured, a cache-busted read seeing the new version while `npm view` did
# not. The per-version document is served uncached (CF-Cache-Status DYNAMIC).
# The `_` query is belt-and-braces against that changing; npm ignores it.
# curl is checked in pre-flight, so there is no packument fallback to lag.
# Probe-only: any failure reads as "not served".
#
# registry.npmjs.org is hardcoded on purpose: server.json declares registryType
# "npm" with no registryBaseUrl, so public npm is exactly the source the MCP
# Registry resolves against. A local .npmrc pointing at a mirror would make
# this answer about the wrong registry.
#
# Necessary, not sufficient, for step 8: this reads npm from THIS machine's CDN
# edge, while the MCP Registry resolves npm from its own. A 200 here does not
# prove the registry can see the version -- the retry loop there is the actual
# backstop, and this gate only keeps the common case from burning an attempt.
npm_version_live() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
    -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "https://registry.npmjs.org/@yawlabs%2Fctxlint/${VERSION}?_=$(date +%s)${RANDOM}" 2>/dev/null || true)
  [ "$code" = "200" ]
}

# =============================================================================
# Step 6: Publish to npm
# =============================================================================
step 6 "Publish to npm"
# This machine is the publisher: there is no CI to hand the publish to. It
# retries only on EOTP-class failures, for a fresh WebAuthn session.

# Fail-closed artifact gate: the dist about to ship must carry the version it
# claims. Re-reads package.json at this step boundary rather than trusting
# $VERSION from script start. The grep target is the JSON.stringify'd
# __VERSION__ literal build.mjs injects; its absence means a stale build
# escaped the step-4 post-bump rebuild (the v0.22.0-ships-0.21.0 failure).
PKG_VERSION_NOW=$(node -p "require('./package.json').version")
if ! grep -q "\"${PKG_VERSION_NOW}\"" dist/index.js 2>/dev/null; then
  fail "dist/index.js lacks baked version \"${PKG_VERSION_NOW}\" -- stale build; step 4's post-bump rebuild should have refreshed it. Investigate before publishing."
fi

# npm_version_live, not `npm view`: a packument read can lag a publish by up to
# 300s, so a re-run right after a later step failed would publish again and
# meet npm's E403 (the loop below treats that as this skip too).
if npm_version_live; then
  info "v${VERSION} already published on npm — skipping"
else
  # Retry only on EOTP/EAUTH/OTP for fresh WebAuthn sessions; fail fast on
  # everything else.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  NPM_ALREADY_THERE=false
  while true; do
    PUBLISH_LOG=$(mktemp)
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      break
    fi
    # npm's own word that the version is already there: the E403 "You
    # cannot publish over the previously published versions". Reachable
    # when the skip check above missed a version npm holds -- its read
    # path lagging the write, or this host unable to read it -- which is
    # the state an immediate re-run after a failed later step starts from.
    # Treated as the skip it should have been, not as a token problem.
    if grep -q 'cannot publish over the previously published versions' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      NPM_ALREADY_THERE=true
      break
    fi
    if ! grep -qE 'EOTP|EAUTH|one-time password|OTP' "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
      fail "npm publish failed (non-OTP error -- see output above). If E401/E404, the automation token in ~/.npmrc is missing or stale: restore/verify it (check the //registry.npmjs.org/:_authToken line; 'npm whoami' should answer). Do NOT re-auth via the web login flow -- it overwrites the automation token with a 2FA-bound session."
    fi
    rm -f "$PUBLISH_LOG"
    if [ $ATTEMPT -ge $MAX_ATTEMPTS ]; then
      fail "npm publish failed after $MAX_ATTEMPTS OTP-class attempts. WebAuthn session may not be propagating."
    fi
    warn "npm publish attempt $ATTEMPT EOTPed -- waiting 30s for WebAuthn session to propagate"
    ATTEMPT=$((ATTEMPT + 1))
    sleep 30
  done
  if [ "$NPM_ALREADY_THERE" = "true" ]; then
    warn "npm already holds @yawlabs/ctxlint@${VERSION} (its E403 said so) though the pre-publish read did not show it -- treating the publish as done"
  else
    info "Published @yawlabs/ctxlint@${VERSION} to npm"
  fi
fi

# =============================================================================
# Step 7: Create GitHub release
# =============================================================================
step 7 "Create GitHub release"
if gh release view "v${VERSION}" >/dev/null 2>&1; then
  info "GitHub release v${VERSION} already exists -- skipping"
else
  # Backstop for step 4's promotion. Unreachable on a straight-through run, but
  # CHANGELOG.md is mutable between the two steps and this script is built to be
  # re-entered, so the check that protects the notes stays beside the notes.
  assert_changelog_promoted

  # The notes are the version's CHANGELOG.md entry, so the release page mirrors
  # the maintained narrative. Never raw commit subjects: they are how v0.18.3
  # through v0.18.7 each shipped while CHANGELOG.md still ended at [0.18.2] and
  # nobody noticed, and how v0.26.0's release page came to list its own
  # version-bump commit.
  NOTES=$(release_notes)

  # --notes-file, not --notes: the body is a whole CHANGELOG section, and
  # passing that as a command-line ARGUMENT exceeds the ~32kB CreateProcess
  # limit on Windows -- `gh: Argument list too long`, exit 126. That killed
  # step 6 of tailscale-mcp's v0.21.0 release AFTER npm had published, and
  # mcp-compliance hit it at 62kB. A file has no such limit anywhere.
  NOTES_FILE=$(mktemp)
  printf '%s\n' "$NOTES" > "$NOTES_FILE"
  gh release create "v${VERSION}" --title "v${VERSION}" --notes-file "$NOTES_FILE"
  rm -f "$NOTES_FILE"
  info "GitHub release created (notes from CHANGELOG.md [${VERSION}])"
fi

# =============================================================================
# Step 8: Publish to the Official MCP Registry
# =============================================================================
# Downstream catalogs (Glama, PulseMCP, mcpservers.org) auto-source from the
# Official MCP Registry; publishing here is what makes the new version visible
# to them. server.json was already bumped in step 4 so the version matches the
# tag.
# mcp_bounded <command...>: run one mcp-publisher call -- a login or a publish
# -- with a time limit, so a registry that never answers cannot hang the
# release. mcp-publisher sends with a bare Go http.Client: Go's default
# transport gives up on a dial after 30 s and on a TLS handshake after 10 s,
# but waits for the answer with no limit at all. The limit here is
# MCP_PUBLISH_TIMEOUT_S seconds (default 90; 0 turns it off), then TERM, then
# KILL MCP_PUBLISH_KILL_AFTER_S seconds later (default 10; at least 1, since
# timeout(1) reads 0 as never), through coreutils timeout(1). --foreground
# keeps mcp-publisher in the terminal's process group, so Ctrl-C still reaches
# it. Git Bash and most glibc distributions ship GNU timeout, Ubuntu 26.04 LTS
# ships uutils' compatible one (its banner also says coreutils), and macOS
# gets it as gtimeout from Homebrew coreutils. BusyBox (Alpine) and Windows'
# own timeout.exe are different programs, which is why the version banner is
# checked. Without a coreutils timeout the call runs unbounded, and a warning
# says so. A call the limit stopped exits 124 -- or 137 when the KILL was
# needed, on newer coreutils such as GNU 9.4 (Git Bash's 8.32 exits 124 even
# then) -- prints a line on stderr saying so, and sets MCP_BOUNDED_STOPPED.
mcp_timeout_setup() {
  MCP_TIMEOUT_READY=1
  MCP_PUBLISH_TIMEOUT_S="${MCP_PUBLISH_TIMEOUT_S:-90}"
  case "$MCP_PUBLISH_TIMEOUT_S" in
    '' | *[!0-9]*)
      warn "MCP_PUBLISH_TIMEOUT_S='${MCP_PUBLISH_TIMEOUT_S}' is not whole seconds -- using 90" >&2
      MCP_PUBLISH_TIMEOUT_S=90
      ;;
  esac
  local kill_after="${MCP_PUBLISH_KILL_AFTER_S:-10}"
  case "$kill_after" in
    '' | *[!0-9]*) kill_after=0 ;;
  esac
  if [ "$kill_after" -eq 0 ]; then
    warn "MCP_PUBLISH_KILL_AFTER_S='${MCP_PUBLISH_KILL_AFTER_S}' is not whole seconds above 0 -- using 10" >&2
    kill_after=10
  fi
  MCP_PUBLISH_KILL_AFTER_S="$kill_after"
  MCP_TIMEOUT_BIN=""
  local t
  for t in timeout gtimeout; do
    command -v "$t" >/dev/null 2>&1 || continue
    case "$("$t" --version 2>/dev/null || true)" in
      *coreutils*)
        MCP_TIMEOUT_BIN="$t"
        break
        ;;
    esac
  done
  if [ -z "$MCP_TIMEOUT_BIN" ]; then
    warn "Neither timeout nor gtimeout on PATH is the coreutils one -- a registry that never answers would hang the MCP Registry step" >&2
  fi
}
mcp_bounded() {
  [ -n "${MCP_TIMEOUT_READY:-}" ] || mcp_timeout_setup
  MCP_BOUNDED_STOPPED=""
  if [ -z "$MCP_TIMEOUT_BIN" ]; then
    "$@"
    return
  fi
  local rc=0
  "$MCP_TIMEOUT_BIN" --foreground -k "$MCP_PUBLISH_KILL_AFTER_S" "$MCP_PUBLISH_TIMEOUT_S" "$@" || rc=$?
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    MCP_BOUNDED_STOPPED=1
    echo "mcp-publisher did not answer within ${MCP_PUBLISH_TIMEOUT_S}s -- stopped it" >&2
  fi
  return "$rc"
}
# mcp_login_fail <message>: fail on a login that did not go through, with
# <message> -- unless the time limit stopped it. That is the registry not
# answering, not a bad credential, and the failure says so instead.
mcp_login_fail() {
  if [ -n "${MCP_BOUNDED_STOPPED:-}" ]; then
    fail "The MCP Registry did not answer the mcp-publisher login within ${MCP_PUBLISH_TIMEOUT_S}s. ALREADY LANDED: npm @yawlabs/ctxlint@${VERSION} and GitHub release v${VERSION} -- ONLY the MCP Registry entry is missing. Re-running ./release.sh ${VERSION} is safe but redoes every gate of steps 1-3 for this one call, so once the registry answers, complete just this step with: cd '$SCRIPT_DIR' && '$MP' login github -token \"\$(gh auth token)\" && '$MP' publish"
  fi
  fail "$1"
}
# The first mcp_bounded call sets the limit up; a value inherited from the
# environment must not stand in for that.
MCP_TIMEOUT_READY=""

# The mcp-publisher release this script downloads, and the SHA-256 of each
# platform's archive in it. The binary is handed a GitHub token, so it is
# pinned and checked rather than taken from releases/latest unverified. The
# digests are the release's own: registry_<version>_checksums.txt and the
# GitHub release-asset digests agree (both read 2026-11-22). To move the pin,
# copy the six mcp-publisher_*.tar.gz lines from the new release's
# checksums.txt. MCP_PUBLISHER=/path/to/mcp-publisher overrides all of it.
MCP_PUBLISHER_VERSION=v1.8.9
mcp_publisher_sha256() {
  case "$1" in
    darwin_amd64) echo f131bc753c293eb754cd183c2201013e0ed7f7a8ac0bd67dd2c4912f029029fd ;;
    darwin_arm64) echo 4175f7281c42ef2f6666d086974aa01f3eecd68a067cfb8329f0a7e620db6e3a ;;
    linux_amd64) echo 4d527ca8f1ced0394c962dc925c2a4a4addef441cbefd62501c875e9481823a8 ;;
    linux_arm64) echo f4eb2e2f0a3d0693247efc117902ebcc651e1d1da973c85ed165db80a93e4fbb ;;
    windows_amd64) echo 6164c564bb7374c5afc9cef7a66e9e2bf951419b748a18c9143ceada6da41acd ;;
    windows_arm64) echo 6912f498dcb8ef49b3bebb9cffdb39f0b649f5999b5250aa8c5630666e60cb2d ;;
    *) return 1 ;;
  esac
}
# SHA-256 of a file: coreutils sha256sum (Linux, Git Bash), else macOS shasum.
file_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

step 8 "Publish to MCP Registry"

if [ ! -f server.json ]; then
  info "No server.json -- not an MCP server, skipping registry publish"
else
  # mcp-publisher cached at ~/.local/bin under its version, so the pin above
  # decides which binary runs: an unversioned copy left by an older run of this
  # script is not reused. The OS/arch detection handles Linux, macOS, and Git
  # Bash on Windows (MINGW/MSYS uname -s starts with "mingw" / "msys").
  MP="${MCP_PUBLISHER:-$HOME/.local/bin/mcp-publisher-${MCP_PUBLISHER_VERSION}}"
  if ! [ -x "$MP" ]; then
    info "mcp-publisher not found at $MP -- downloading ${MCP_PUBLISHER_VERSION}"
    mkdir -p "$(dirname "$MP")"
    OS_RAW=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS_RAW" in mingw*|msys*|cygwin*) OS=windows ;; *) OS="$OS_RAW" ;; esac
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    MP_SHA256=$(mcp_publisher_sha256 "${OS}_${ARCH}") \
      || fail "No pinned mcp-publisher digest for ${OS}_${ARCH} -- set MCP_PUBLISHER=/path/to/mcp-publisher"
    TMP=$(mktemp -d)
    curl -fsSL -o "$TMP/mp.tar.gz" \
      "https://github.com/modelcontextprotocol/registry/releases/download/${MCP_PUBLISHER_VERSION}/mcp-publisher_${OS}_${ARCH}.tar.gz" \
      || fail "Failed to download mcp-publisher ${MCP_PUBLISHER_VERSION} (${OS}/${ARCH})"
    MP_GOT=$(file_sha256 "$TMP/mp.tar.gz")
    if [ "$MP_GOT" != "$MP_SHA256" ]; then
      rm -rf "$TMP"
      fail "mcp-publisher ${MCP_PUBLISHER_VERSION} (${OS}_${ARCH}) has SHA-256 $MP_GOT, expected $MP_SHA256 -- refusing to run it with a GitHub token"
    fi
    tar xzf "$TMP/mp.tar.gz" -C "$TMP" || fail "Failed to extract mcp-publisher tarball"
    if [ -f "$TMP/mcp-publisher.exe" ]; then
      mv "$TMP/mcp-publisher.exe" "$MP"
    else
      mv "$TMP/mcp-publisher" "$MP"
    fi
    rm -rf "$TMP"
    chmod +x "$MP" 2>/dev/null || true
  fi

  # OIDC auth (used by the old release.yml) only works inside Actions; locally
  # we use a GitHub PAT via `login github -token <PAT>`. At login the registry
  # reads the org roles this token can see, and grants io.github.YawLabs/* only
  # to a YawLabs org Owner (read:org lets it read them; so do repo, user,
  # write:org and admin:org). It enforces the grant only at publish: a token
  # that cannot read the roles still logs in, and the publish gets a 403.
  # Fall back to gh CLI's session token if MCP_REGISTRY_TOKEN is unset --
  # gh auth login (admin:org or read:org scope) covers the namespace claim.
  : "${MCP_REGISTRY_TOKEN:=$(gh auth token 2>/dev/null || true)}"
  if [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
    fail "MCP_REGISTRY_TOKEN unset -- set it to a GitHub PAT with read:org for YawLabs (or run '$MP login github' once interactively to cache the session)."
  fi
  mcp_bounded "$MP" login github -token "$MCP_REGISTRY_TOKEN" >/dev/null \
    || mcp_login_fail "mcp-publisher login failed -- its output is above. A 401 there is the registry refusing the token exchange: most often MCP_REGISTRY_TOKEN, or the gh CLI token it fell back to, is invalid or expired, though the registry answers 401 when GitHub's own API fails too. A 429, a 5xx or a connection error is the registry or the network. ALREADY LANDED: npm @yawlabs/ctxlint@${VERSION} and GitHub release v${VERSION} -- ONLY the MCP Registry entry is missing. Re-running ./release.sh ${VERSION} is safe but redoes every gate of steps 1-3 for this one call, so once the cause is fixed, complete just this step with: cd '$SCRIPT_DIR' && '$MP' login github -token \"\$(gh auth token)\" && '$MP' publish"

  # npm propagation gate. npm accepts a publish and then can take minutes to
  # serve the new version ("Your package is being processed and may take a few
  # minutes to become available"). Until it does, the MCP Registry rejects the
  # publish with HTTP 400 "NPM package '@yawlabs/ctxlint' exists, but version
  # 'X.Y.Z' was not found (status: 404)" -- which is what killed the v0.25.0
  # run with npm AND the GitHub release already landed, and step 9 never
  # reached.
  #
  # 100 x 6s (600 s), and placed HERE rather than in step 6 so it covers every
  # path into step 8: this run's publish, and a resume whose publish happened
  # in an earlier invocation. A poll that runs out does not fail -- it warns and
  # lets the publish speak, since the retry below is the real backstop.
  #
  # Why 600s: the @yawlabs/fetch-mcp 0.8.2 release (2026-09-29) spent 295 s of
  # its own 300 s gate waiting for npm to serve its new version. Before that
  # this was 120s, raised from 60s after the v0.27.0 run (2026-09-13) ran it
  # out and was accepted by the registry only on attempt 3 of 3 of the publish
  # retries below (there are four now), about 150s after the publish. The
  # waits only elapse on a run that is still propagating.
  NPM_POLLS=100
  NPM_SERVING=false
  for ((i = 1; i <= NPM_POLLS; i++)); do
    if npm_version_live; then NPM_SERVING=true; break; fi
    [ "$i" -eq 1 ] && info "Waiting for npm to serve v${VERSION} before registering it (up to ${NPM_POLLS} reads 6s apart)"
    sleep 6
  done
  if [ "$NPM_SERVING" = "true" ]; then
    info "npm registry serves @yawlabs/ctxlint@${VERSION} -- safe to register"
  else
    warn "npm registry still does not serve @yawlabs/ctxlint@${VERSION} after $((NPM_POLLS * 6))s -- attempting the registry publish anyway"
  fi

  # The failure message has to name what ALREADY landed: at this point npm and
  # the GitHub release are both live, so re-running the whole script to retry
  # one HTTP call is how a released version gets touched again for no reason.
  # The \$( ) is escaped so the printed command carries the literal
  # `$(gh auth token)` for the reader to run -- expanding it here would print a
  # live GitHub token into the terminal (and into whatever log captures it).
  MCP_FIX_CMD="cd '$SCRIPT_DIR' && '$MP' login github -token \"\$(gh auth token)\" && '$MP' publish"
  MCP_FAIL_MSG="mcp-publisher publish failed for v${VERSION}. ALREADY LANDED: npm @yawlabs/ctxlint@${VERSION} and GitHub release v${VERSION} -- ONLY the MCP Registry entry is missing. Re-running ./release.sh ${VERSION} is safe but redoes every gate of steps 1-3 for this one call, so fix the cause, then complete just this step with: ${MCP_FIX_CMD}"

  # Four attempts, spaced 30s, 60s, then 90s (180s in all), and ONLY for the
  # shapes waiting cures.
  #
  # Why more than one retry: the gate above reads npm from this machine's CDN
  # edge, so it can go green while the registry's own view still lags. Going
  # green early is what SHRINKS the budget -- a single 30s retry would cover
  # a fraction of the minutes npm's own notice warns of. The waits only
  # elapse on a run that is already failing. The fourth attempt is the margin
  # the v0.27.0 run (2026-09-13) had none of: it succeeded on attempt 3 of 3.
  #
  # The live registry (v1.8.1; wording from registry PR #1411) answers that
  # lag with "exists, but version '<v>' was not found (status: 404)", and a
  # bad moment on npm's side with "... Likely transient, retry later" (429,
  # 5xx, an inconclusive 404) or "failed to fetch package metadata from NPM"
  # (no status at all). Every other failure -- bad server.json, namespace not
  # owned, auth -- fails identically after any wait, so it exits on the first
  # attempt rather than buying a silent 90s (the registry's own 429-504 and an
  # attempt that got no answer, below, aside). The version has to appear in the
  # SAME output as the not-found text, or an unrelated "not found" (a package
  # missing outright names no version) would buy those waits too; the
  # "Likely transient" texts match on their own, since 429 and 5xx name only
  # the package.
  # ctxlint logs in BEFORE its npm gate above, which can run past the
  # registry token's 5 minutes on its own; refresh it right before the first
  # attempt too, not only between retries.
  mcp_bounded "$MP" login github -token "${MCP_REGISTRY_TOKEN:-}" >/dev/null \
    || warn "mcp-publisher login refresh failed -- the next attempt may be refused as unauthorized"

  # The registry's OWN transient answers are retried on the same clock too:
  # HTTP 429, 502, 503 or 504 on the publish call. Cutting @yawlabs/mcp 1.0.17
  # (2026-09-29) met a 504 from the registry's nginx gateway while its search
  # requests were timing out -- the registry was slow, not saying no. A retry
  # is safe even when the timed-out attempt landed: it then meets the
  # duplicate-version branch below.
  # An attempt that gets no answer at all is retried on the same clock:
  # mcp_bounded (above) stops one the registry never answers, and the client
  # reports a connection that drops before or while answering as "error
  # sending request" or "error reading response". The request may have landed
  # then, so a duplicate on the retry means it did. A connection the client
  # reports as never opened -- a dial, DNS, proxy or certificate error, a TLS
  # handshake that timed out, a proxy that refused the tunnel -- is retried as
  # well, but cannot have landed, and neither can an attempt the registry
  # refused with a 429. A handshake the far end cut off reads like any other
  # drop (EOF, a reset), and is treated as one.
  MCP_PUBLISH_LOG=$(mktemp)
  MCP_DONE=false
  MCP_ATTEMPT=1
  MCP_MAX_ATTEMPTS=4
  MCP_GATEWAY_RETRIED=false
  # Already set up by the first login above; repeated here as a no-op so the
  # checks after the pipeline never depend on that login having run: the
  # attempt below runs in a pipeline's subshell, which cannot set it for them.
  [ -n "${MCP_TIMEOUT_READY:-}" ] || mcp_timeout_setup
  while true; do
    # `|| MCP_PUBLISH_RC=$?` rather than `if`: the exit code is what tells an
    # attempt the limit stopped (124, or 137 where the KILL was needed) from
    # the rest, and under pipefail it is the publisher's, not tee's.
    MCP_PUBLISH_RC=0
    mcp_bounded "$MP" publish 2>&1 | tee "$MCP_PUBLISH_LOG" || MCP_PUBLISH_RC=$?
    if [ "$MCP_PUBLISH_RC" -eq 0 ]; then
      MCP_DONE=true
      break
    fi
    # Already registered -- the state a resume run lands in, and success for
    # this step's purpose. The script's header promises a re-run skips what
    # already landed, and without this a re-verify run would exit 1 claiming the
    # registry entry is missing when it is the one thing that IS there.
    if grep -qiE 'duplicate version|already exists' "$MCP_PUBLISH_LOG"; then
      if [ "$MCP_GATEWAY_RETRIED" = "true" ]; then
        info "MCP Registry refused the retry of ${VERSION} as a duplicate: an attempt of this run that got no clear answer landed"
      else
        info "MCP Registry already has ${VERSION} -- nothing to publish"
      fi
      MCP_DONE=true
      break
    fi
    # The registry's own 429/502/503/504 on the publish call, if that is what
    # this attempt got: empty otherwise. `|| true` because no match is the
    # normal case, and the failing grep would then make the assignment fail,
    # which `set -e` turns into the end of the script.
    MCP_GATEWAY_STATUS=$(grep -oE 'server returned status (429|502|503|504)([^0-9]|$)' "$MCP_PUBLISH_LOG" | head -n 1 | grep -oE '[0-9]{3}' || true)
    # No answer at all, if that is what this attempt got: empty otherwise. A
    # proxy that refuses the tunnel leaves only the rest of its status line
    # right after the quoted URL: a reason phrase that starts with a capital
    # (Go's own errors there start lower case, or are EOF), nothing at all, or
    # "unknown status code" when the line stops at the code. Matching it right
    # after the URL keeps bytes a server echoes back inside Go's own quoted
    # error text from passing for one. A refusal of any other shape reads as a
    # drop, which changes only how a later duplicate is reported.
    MCP_NO_ANSWER=""
    MCP_MAY_HAVE_LANDED=false
    if [ -n "${MCP_TIMEOUT_BIN:-}" ] && { [ "$MCP_PUBLISH_RC" -eq 124 ] || [ "$MCP_PUBLISH_RC" -eq 137 ]; }; then
      MCP_NO_ANSWER="did not answer within ${MCP_PUBLISH_TIMEOUT_S}s"
      MCP_MAY_HAVE_LANDED=true
    elif grep -q 'error sending request' "$MCP_PUBLISH_LOG" \
      && grep -qE 'dial tcp|proxyconnect|tls:|x509:|TLS handshake timeout|error sending request: [A-Z][a-z]+ "[^"]*": ( *|unknown status code|[A-Z]([a-z]|[A-Z]+[ a-z(-]).*)$' "$MCP_PUBLISH_LOG"; then
      MCP_NO_ANSWER="could not be reached"
    elif grep -qE 'error sending request|error reading response' "$MCP_PUBLISH_LOG"; then
      MCP_NO_ANSWER="dropped the connection without an answer"
      MCP_MAY_HAVE_LANDED=true
    fi
    # Not a shape waiting cures, or out of attempts.
    # The not-found shape counts only when the validator's own "version '<v>'"
    # names this version. A bare version match is not enough: the registry's
    # publisher after v1.8.1 prints "Publishing <name>@<v> to" before any
    # error, and MCP_PUBLISHER_VERSION pins a release after it, so a
    # missing-package 404 would then buy all the waits.
    if ! { { grep -qE 'not found \(status: *[0-9]+\)' "$MCP_PUBLISH_LOG" && grep -qF "version '${VERSION}'" "$MCP_PUBLISH_LOG"; } \
        || grep -qE 'Likely transient, retry later|failed to fetch package metadata from NPM' "$MCP_PUBLISH_LOG" \
        || [ -n "$MCP_GATEWAY_STATUS" ] \
        || [ -n "$MCP_NO_ANSWER" ]; }; then
      break
    fi
    if [ "$MCP_ATTEMPT" -ge "$MCP_MAX_ATTEMPTS" ]; then break; fi
    MCP_WAIT=$((MCP_ATTEMPT * 30))
    if [ -n "$MCP_GATEWAY_STATUS" ]; then
      # A 502-504 can come after the attempt landed; a 429 refused it.
      if [ "$MCP_GATEWAY_STATUS" != 429 ]; then MCP_GATEWAY_RETRIED=true; fi
      warn "MCP Registry answered HTTP ${MCP_GATEWAY_STATUS} itself -- busy or timing out, not a verdict -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    elif [ -n "$MCP_NO_ANSWER" ]; then
      if [ "$MCP_MAY_HAVE_LANDED" = true ]; then MCP_GATEWAY_RETRIED=true; fi
      warn "MCP Registry ${MCP_NO_ANSWER} -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    else
      warn "MCP Registry cannot see @yawlabs/ctxlint@${VERSION} on npm yet -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    fi
    sleep "$MCP_WAIT"
    # A fresh registry token before every retry: tokens last 5 minutes, and an
    # attempt that meets a timing-out gateway spends the gateway's own timeout
    # before its 504 arrives, so the waits plus four slow attempts can outlast
    # the token the login above issued -- and an expired token is a 401 that
    # fails the step.
    mcp_bounded "$MP" login github -token "${MCP_REGISTRY_TOKEN:-}" >/dev/null \
      || warn "mcp-publisher login refresh failed -- the next attempt may be refused as unauthorized"
    MCP_ATTEMPT=$((MCP_ATTEMPT + 1))
  done
  # The registry decides the namespace grant at login, from the org roles the
  # token can read, but enforces it only at publish: a token that cannot read
  # YawLabs org roles, or whose owner is not a YawLabs org Owner, logs in fine
  # and is refused here with a 403.
  MCP_REFUSED_NAMESPACE=false
  if grep -q 'server returned status 403' "$MCP_PUBLISH_LOG"; then MCP_REFUSED_NAMESPACE=true; fi
  rm -f "$MCP_PUBLISH_LOG"
  if [ "$MCP_DONE" = "true" ]; then
    info "Published to MCP Registry"
  else
    if [ "$MCP_REFUSED_NAMESPACE" = true ]; then
      warn "A 403 on publish is the registry refusing the io.github.YawLabs namespace. It grants that namespace only to a YawLabs org Owner whose token can read org roles: a classic PAT with the repo, user, read:org, write:org or admin:org scope, or a fine-grained PAT with read access to the organization's Members. The membership does not have to be public, whatever the registry's own message says."
    fi
    fail "$MCP_FAIL_MSG"
  fi
fi

# =============================================================================
# Step 9: Verify
# =============================================================================
step 9 "Verify"

# npm_version_live (the uncached per-version document), not `npm view`, whose
# packument the CDN can serve up to 300 s stale -- polled up to 120 times 5s
# apart (about 600s of sleeps, plus each read) rather than read once after 3s:
# the @yawlabs/fetch-mcp 0.8.2 release (2026-09-29) spent 295 s of its 300 s
# gate waiting for npm to serve its new version, and the gate in step 8 only
# warns when it runs out.
NPM_VERSION=""
for i in $(seq 1 120); do
  if npm_version_live; then NPM_VERSION="$VERSION"; break; fi
  if [ "$i" -lt 120 ]; then sleep 5; fi
done
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/ctxlint@${NPM_VERSION}"
else
  warn "npm does not serve @yawlabs/ctxlint@${VERSION} after 120 reads of https://registry.npmjs.org/@yawlabs%2Fctxlint/${VERSION} -- may still be propagating"
fi

PKG_VERSION=$(node -p "require('./package.json').version")
if [ "$PKG_VERSION" = "$VERSION" ]; then
  info "package.json: ${PKG_VERSION}"
else
  warn "package.json shows ${PKG_VERSION} (expected $VERSION)"
fi

if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
  info "git tag: v${VERSION}"
else
  warn "git tag v${VERSION} not found"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}  v${VERSION} released successfully!${NC}"
echo ""
echo -e "  npm: https://www.npmjs.com/package/@yawlabs/ctxlint"
echo -e "  git: https://github.com/yawlabs/ctxlint/releases/tag/v${VERSION}"
echo ""
