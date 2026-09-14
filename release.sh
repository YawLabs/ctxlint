#!/bin/bash
# =============================================================================
# ctxlint Release Script — Build, tag, publish to npm
# =============================================================================
# Usage:
#   ./release.sh <new-version>    — full release from local machine
#   ./release.sh                  — CI mode (derives version from git tag)
#
# If interrupted, re-run with the same version — each step is idempotent.
#
# Prerequisites:
#   - Node.js 20+ and pnpm installed
#   - npm authenticated (npm whoami)
#   - gh CLI authenticated (for verification)
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
#   * The Keep-a-Changelog link references at the bottom, when the file has
#     them, are moved along: [Unreleased] compares from the new tag, and the
#     version gets its own compare link.
#
# Step 1's gate and step 7's release-notes lookup have to agree on what counts
# as "an entry for this version". Two copies of this awk is exactly how a gate
# passes and its consumer then finds nothing, so the extraction lives here once.
# Prints the body of `## [<heading>]` up to the next `## [` heading.
changelog_section() {
  [ -f CHANGELOG.md ] || return 0
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
# previous tag, newest first, with version-bump commits dropped.
changelog_generated_body() {
  local prev=$1 range subjects
  if [ -n "$prev" ]; then range="${prev}..HEAD"; else range="HEAD"; fi
  subjects=$(git log --no-merges --format='%s' "$range" 2>/dev/null \
    | grep -vE '^v[0-9]+\.[0-9]+\.[0-9]+$' | sed 's/^/- /' || true)
  [ -n "$subjects" ] || subjects="- Maintenance release; no changes since ${prev:-the previous release}."
  printf '### Changed\n%s\n' "$subjects"
}

# Keep-a-Changelog link references, when the file uses them: [Unreleased]
# compares from the new tag, and the version gets its own compare link (or a
# tag link on a first release). A version link that already exists is kept.
# This file carries no link references today, so this is a no-op here until
# someone adds them; it is kept so the helper block matches the sibling repos.
changelog_update_links() {
  local prev=$1 tmp
  grep -qE '^\[Unreleased\]: .*/compare/.*\.\.\.HEAD' CHANGELOG.md || return 0
  tmp=$(mktemp)
  awk -v ver="$VERSION" -v prev="$prev" -v have_link="$(grep -c "^\[${VERSION}\]: " CHANGELOG.md || true)" '
    !done && /^\[Unreleased\]: .*\/compare\/.*\.\.\.HEAD/ {
      url=$0; sub(/^\[Unreleased\]: /, "", url); sub(/\/compare\/.*$/, "", url)
      print "[Unreleased]: " url "/compare/v" ver "...HEAD"
      if (have_link == 0) {
        if (prev != "") print "[" ver "]: " url "/compare/" prev "...v" ver
        else print "[" ver "]: " url "/releases/tag/v" ver
      }
      done=1; next
    }
    { print }
  ' CHANGELOG.md > "$tmp" || { rm -f "$tmp"; fail "CHANGELOG.md link update failed"; }
  mv "$tmp" CHANGELOG.md
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
# author promoted by hand) only re-checks the link references.
promote_changelog() {
  [ -f CHANGELOG.md ] || return 0
  local prev
  prev=$(changelog_prev_tag)
  if changelog_nonempty "$(changelog_section "$VERSION")"; then
    info "CHANGELOG.md already has an entry for v${VERSION}"
    changelog_update_links "$prev"
    return 0
  fi
  local today tmp dash heading body
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
  changelog_update_links "$prev"
}

# Backstop for the promotion above: every release has an entry now, so a
# missing one means promote_changelog did not run or did not land, and the
# release notes in step 7 would silently fall back to commit subjects.
assert_changelog_promoted() {
  [ -f CHANGELOG.md ] || return 0
  changelog_nonempty "$(changelog_section "$VERSION")" && return 0
  fail "CHANGELOG.md has no '## [${VERSION}]' entry. Step 4 should have written it -- promote_changelog did not run or did not land."
}

# Release notes for step 7: the version's changelog section, trimmed of the
# blank lines around it; commit subjects only when there is no changelog.
release_notes() {
  local notes
  notes=$(changelog_section "$VERSION" | sed -e '/./,$!d' | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')
  if changelog_nonempty "$notes"; then
    printf '%s\n' "$notes"
  elif [ -n "${1:-}" ] && [ "$1" != "v${VERSION}" ]; then
    git log --oneline "${1}..v${VERSION}" --no-decorate | sed 's/^[a-f0-9]* /- /'
  else
    printf 'Initial release\n'
  fi
}
# --- end CHANGELOG helpers ---

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
# Step 4 runs this after the package.json bump. A RESUME also runs it during
# pre-flight, before step 1: when an earlier run bumped package.json and then
# died before these syncs finished, step 3's tests (server.json and the pins in
# entry.test.ts, and version-refs.test.ts --check) fail on that half-bumped
# tree, so a resume that waited for step 4 would never get there.
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
      info "server.json synced to $VERSION"
    fi
  fi
}

# SKIP_LINT=1 escape hatch -- wraps `npm`/`pnpm` so that any `run lint*` is a
# no-op. Concretely, what it skips is `eslint src/` (package.json `lint`) and
# nothing else: typecheck, tests and the build still run.
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
if [ "${SKIP_LINT:-}" = "1" ]; then
  npm() {
    if [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'npm run $2'"
      return 0
    fi
    command npm "$@"
  }
  pnpm() {
    if [ "$1" = "run" ] && [[ "$2" == lint* ]]; then
      warn "SKIP_LINT=1 -- noop 'pnpm run $2'"
      return 0
    fi
    command pnpm "$@"
  }
fi

TOTAL_STEPS=9

# ---- Resolve version ----
VERSION="${1:-}"
IS_CI="${CI:-false}"

if [ -z "$VERSION" ]; then
  if [ "$IS_CI" = "true" ] && [ -n "${GITHUB_REF_NAME:-}" ]; then
    VERSION="${GITHUB_REF_NAME#v}"
    info "CI mode — version $VERSION from tag $GITHUB_REF_NAME"
  else
    echo "Usage: ./release.sh <version>"
    echo "  e.g. ./release.sh 0.6.0"
    exit 1
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  fail "Invalid version format: $VERSION (expected X.Y.Z)"
fi

# ---- Pre-flight checks ----
echo -e "${CYAN}Pre-flight checks...${NC}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

command -v node >/dev/null  || fail "node not installed"
command -v pnpm >/dev/null  || fail "pnpm not installed"
command -v npm >/dev/null   || fail "npm not installed"

CURRENT_VERSION=$(node -p "require('./package.json').version")
RESUMING=false

if [ "$CURRENT_VERSION" = "$VERSION" ]; then
  RESUMING=true
  info "Already at v${VERSION} — resuming"
  # Before step 3, whose tests fail on exactly this state. See sync_version_files.
  sync_version_files
else
  if [ "$IS_CI" != "true" ]; then
    if [ -n "$(git status --porcelain)" ]; then
      fail "Working directory not clean. Commit or stash changes first."
    fi
  fi
  info "Current: v${CURRENT_VERSION} → v${VERSION}"
fi

if [ "$IS_CI" != "true" ] && [ "$RESUMING" != "true" ]; then
  echo ""
  echo -e "${YELLOW}About to release v${VERSION}. This will:${NC}"
  echo "  1. Lint & type-check"
  echo "  2. Build"
  echo "  3. Test"
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
fi

# =============================================================================
# Step 1: Lint & type-check
# =============================================================================
step 1 "Lint & type-check"

# Say up front which release notes this run will publish. Purely informational
# -- step 4 writes the [${VERSION}] entry itself, so an unpromoted CHANGELOG is
# not a failure here and must not abort: aborting would block the script from
# doing the one mechanical edit it is perfectly capable of making.
if [ ! -f CHANGELOG.md ]; then
  warn "Release notes: no CHANGELOG.md -- will fall back to commit subjects"
elif changelog_nonempty "$(changelog_section "$VERSION")"; then
  info "Release notes: existing CHANGELOG.md entry for v${VERSION}"
elif changelog_nonempty "$(changelog_section "Unreleased")"; then
  info "Release notes: [Unreleased] section, which step 4 will promote to [${VERSION}]"
else
  warn "Release notes: no CHANGELOG.md entry and no [Unreleased] content -- step 4 will write [${VERSION}] from the commit subjects since the previous tag"
fi

# A crashed linter is not a lint result -- and it is not a pass either. Lint
# here is `eslint src/`: pure JS on node, with no native binary to segfault,
# and it exits 0 on MINGW64-ARM64 (measured 2026-09-11). So a 139 / 3221225477
# from this command is not a known platform quirk to wave through; it means no
# verdict was produced. Nothing downstream re-checks it either -- there is no
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
  rm -f "$LINT_OUT"
  if [ "$LINT_RC" -eq 139 ] || [ "$LINT_RC" -eq 3221225477 ]; then
    fail "Lint runner CRASHED (exit $LINT_RC) -- no lint verdict was produced, so the release stops here. eslint is pure JS and is not expected to crash on this platform, so investigate rather than skip. As an explicit last resort, SKIP_LINT=1 ./release.sh ${VERSION} releases with lint unverified -- and there is no CI to catch what that misses."
  fi
  fail "Lint failed (exit $LINT_RC)"
fi
rm -f "$LINT_OUT"

# Type-check. Previously a distinct step in the (now removed) GitHub Actions
# ci.yml / release.yml -- release.sh is the sole quality gate now, so it runs
# here. Invoked as `npx tsc` (not `pnpm run`) so neither the SKIP_LINT wrapper
# nor the MINGW64-ARM `pnpm run` exit-segfault (platform-windows.md) touches it.
npx tsc --noEmit
info "Type-check passed"

# =============================================================================
# Step 2: Build
# =============================================================================
step 2 "Build"

pnpm run build
info "Build complete"

# =============================================================================
# Step 3: Test
# =============================================================================
step 3 "Test"

pnpm run test:run
info "All tests passed"

# =============================================================================
# Step 4: Bump version
# =============================================================================
step 4 "Bump version to $VERSION"

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

if [ "$IS_CI" = "true" ]; then
  info "CI mode — skipping commit/tag/push (already tagged)"
else
  # Commit if there are changes
  BUMP_FILES="package.json pnpm-lock.yaml .pre-commit-hooks.yaml README.md"
  [ -f server.json ] && BUMP_FILES="$BUMP_FILES server.json"
  # promote_changelog wrote the [${VERSION}] entry in step 4; without
  # CHANGELOG.md here that edit is left uncommitted in the working tree and the
  # next run's pre-flight clean-tree check refuses to start.
  [ -f CHANGELOG.md ] && BUMP_FILES="$BUMP_FILES CHANGELOG.md"
  if [ -n "$(git status --porcelain $BUMP_FILES 2>/dev/null)" ]; then
    git add $BUMP_FILES
    git commit -m "v${VERSION}"
    info "Committed version bump"
  else
    info "Nothing to commit"
  fi

  # Tag if not already tagged
  if git tag -l "v${VERSION}" | grep -q "v${VERSION}"; then
    info "Tag v${VERSION} already exists"
  else
    git tag -a "v${VERSION}" -m "v${VERSION}"
    info "Tag v${VERSION} created"
  fi

  # Push
  # Tag-drift safety: refuse to push if origin already has a tag at this name
  # pointing to a different commit (rewound tag elsewhere, parallel release race).
  # Without this check, `git push --follow-tags` SILENTLY skips updating the
  # tag on origin (the tag exists, no fast-forward happens). The main push
  # reports success, but origin's tag stays at the old SHA -- and the later
  # `gh release create` step then creates a GitHub release linked to that
  # stale commit while npm carries the new one.
  ORIGIN_TAG_SHA=$(git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | awk '{print $1}')
  if [ -n "$ORIGIN_TAG_SHA" ]; then
    LOCAL_TAG_SHA=$(git rev-parse "v${VERSION}")
    if [ "$ORIGIN_TAG_SHA" != "$LOCAL_TAG_SHA" ]; then
      fail "Tag v${VERSION} exists on origin at $ORIGIN_TAG_SHA but local tag points to $LOCAL_TAG_SHA -- resolve the drift before re-running"
    fi
  fi

  git push origin main --tags
  info "Pushed to origin"
fi

# =============================================================================
# True when the npm registry ITSELF serves this version. Used by step 6's
# post-publish verification and by step 8's gate before registering.
#
# Deliberately NOT a bare `npm view`: npm answers from its own on-disk HTTP
# cache, which this run primes with a packument fetched BEFORE the publish (the
# lookup that decides "already published -- skipping"). Measured on the v0.25.0
# run: a cache-busted registry read saw the new version while `npm view` was
# still serving the stale one. `--prefer-online` is the no-curl fallback -- it
# forces revalidation instead of trusting the cache.
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
  if command -v curl >/dev/null 2>&1; then
    code=$(curl -sS -o /dev/null -w '%{http_code}' \
      -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
      "https://registry.npmjs.org/@yawlabs%2fctxlint/${VERSION}" 2>/dev/null || echo "000")
    [ "$code" = "200" ]
  else
    [ "$(npm view "@yawlabs/ctxlint@${VERSION}" version --prefer-online 2>/dev/null || echo "")" = "$VERSION" ]
  fi
}

# =============================================================================
# Step 6: Publish to npm
# =============================================================================
step 6 "Publish to npm"
# Three publish paths, picked by environment:
#   1. IS_CI=true                    -> WE are CI. Do the publish (NODE_AUTH_TOKEN
#                                       is set; --provenance for sigstore).
#   2. IS_CI=false + release.yml     -> CI will publish on the tag we just pushed.
#      exists with CI publish path      Watch `gh run watch` for that run and
#                                       verify via `npm view`. Workstation MUST
#                                       NOT also publish -- stale ~/.npmrc fails
#                                       E404, valid one races CI for the same
#                                       version. CI is authoritative.
#   3. IS_CI=false + no CI publish   -> Workstation IS the publisher. Try locally
#      path                             with EOTP retry for fresh WebAuthn sessions.

# Fail-closed artifact gate: the dist about to ship must carry the version it
# claims. Re-reads package.json at this step boundary rather than trusting
# $VERSION from script start. The grep target is the JSON.stringify'd
# __VERSION__ literal build.mjs injects; its absence means a stale build
# escaped the step-4 post-bump rebuild (the v0.22.0-ships-0.21.0 failure).
PKG_VERSION_NOW=$(node -p "require('./package.json').version")
if ! grep -q "\"${PKG_VERSION_NOW}\"" dist/index.js 2>/dev/null; then
  fail "dist/index.js lacks baked version \"${PKG_VERSION_NOW}\" -- stale build; step 4's post-bump rebuild should have refreshed it. Investigate before publishing."
fi

PUBLISHED_VERSION=$(npm view "@yawlabs/ctxlint@${VERSION}" version 2>/dev/null || echo "")
if [ "$PUBLISHED_VERSION" = "$VERSION" ]; then
  info "v${VERSION} already published on npm — skipping"
  # Resume-path safety: a prior interrupted run may have published but never
  # observed `gh run watch` to completion. Later CI steps (smoke test, MCP
  # Registry publish, attestation upload) could have failed silently. Look
  # up the most recent Release run for this tag and warn if its conclusion
  # was non-success. Best-effort -- if the tag isn't on origin yet or the
  # run isn't visible, the warn just doesn't fire.
  if [ "$IS_CI" != "true" ] && [ -f ".github/workflows/release.yml" ]; then
    RESUME_TAG_SHA=$(git rev-parse "v${VERSION}^{}" 2>/dev/null || echo "")
    if [ -n "$RESUME_TAG_SHA" ]; then
      RESUME_CONCLUSION=$(gh run list --workflow=Release --event=push --commit="$RESUME_TAG_SHA" --limit=1 --json conclusion --jq '.[0].conclusion' 2>/dev/null || echo "")
      if [ -n "$RESUME_CONCLUSION" ] && [ "$RESUME_CONCLUSION" != "success" ]; then
        warn "Prior CI Release run for v${VERSION} ended with conclusion='$RESUME_CONCLUSION' (not 'success'). A post-publish step (smoke test, MCP Registry publish, attestation) may have failed silently. Inspect: gh run list --workflow=Release --commit=$RESUME_TAG_SHA --limit=3"
      fi
    fi
  fi
elif [ "$IS_CI" = "true" ]; then
  npm publish --access public --provenance
  info "Published @yawlabs/ctxlint@${VERSION} to npm (with provenance)"
elif [ -f ".github/workflows/release.yml" ] && grep -q "npm publish\|NODE_AUTH_TOKEN" .github/workflows/release.yml; then
  info "CI release.yml fires on v* tag push -- workstation hands off to CI"
  # Verify the tag landed on origin BEFORE looking up the CI run. A local
  # push that succeeded but the remote rejected (protected-tag rule, network
  # blip) would otherwise dead-end in the lookup loop with a misleading
  # "Push may have failed" error 62s later. ls-remote is one round-trip --
  # cheap relative to gh run watch.
  if ! git ls-remote --tags origin "refs/tags/v${VERSION}" 2>/dev/null | grep -q "refs/tags/v${VERSION}$"; then
    fail "Tag v${VERSION} not visible on origin. Step 4's 'git push --follow-tags' may have failed silently (protected-tag rule, network blip), or the tag was deleted between push and now. Re-run step 4."
  fi
  TAG_SHA=$(git rev-parse "v${VERSION}^{}")
  RUN_ID=""
  # Exponential backoff: 2+4+8+16+32 = 62s upper bound on GitHub's
  # tag-push -> actions queue visibility lag. Cheap relative to the CI run
  # itself (~6 min on aws-mcp).
  DELAY=2
  for i in 1 2 3 4 5; do
    RUN_ID=$(gh run list --workflow=Release --event=push --commit="$TAG_SHA" --limit=1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || echo "")
    [ -n "$RUN_ID" ] && break
    sleep $DELAY
    DELAY=$((DELAY * 2))
  done
  if [ -z "$RUN_ID" ]; then
    fail "Could not find Release workflow run for tag v${VERSION} (commit $TAG_SHA) after 62s of polling. The actions queue may be backed up; check 'gh run list --limit 5' and rerun the script to retry."
  fi
  info "Watching CI Release run $RUN_ID"
  gh run watch "$RUN_ID" --exit-status || fail "CI Release run $RUN_ID failed. See 'gh run view $RUN_ID --log-failed'."
  # CI is authoritative on the publish itself -- if `gh run watch` exited 0,
  # the package is live on npm regardless of how long the registry mirror
  # takes to surface it. Verification here is a courtesy check; warn rather
  # than fail when the mirror lags (existing memory: lag can exceed a minute).
  # npm_version_live, not a bare `npm view`: the latter can answer from the
  # packument this run already cached and report "not found" for a version
  # that is live, turning a good release into a spurious warning.
  NPM_LIVE=false
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if npm_version_live; then NPM_LIVE=true; break; fi
    sleep 6
  done
  if [ "$NPM_LIVE" = "true" ]; then
    info "Published @yawlabs/ctxlint@${VERSION} via CI Release run $RUN_ID"
  else
    warn "CI Release run $RUN_ID succeeded but the npm registry still does not serve @yawlabs/ctxlint@${VERSION} after 60s. Likely propagation lag -- verify with 'npm view @yawlabs/ctxlint@${VERSION} --prefer-online' in a minute. Publish is authoritative on CI's exit code."
  fi
else
  # Workstation IS the publisher (no CI fallback). Retry only on EOTP/EAUTH/OTP
  # for fresh WebAuthn sessions; fail fast on everything else.
  ATTEMPT=1
  MAX_ATTEMPTS=3
  while true; do
    PUBLISH_LOG=$(mktemp)
    if npm publish --access public 2>&1 | tee "$PUBLISH_LOG"; then
      rm -f "$PUBLISH_LOG"
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
  info "Published @yawlabs/ctxlint@${VERSION} to npm (workstation)"
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
  # the maintained narrative. Commit subjects only when there is no CHANGELOG.md
  # at all: raw subjects are how v0.18.3 through v0.18.7 each shipped while
  # CHANGELOG.md still ended at [0.18.2] and nobody noticed, and how v0.26.0's
  # release page came to list its own version-bump commit.
  PREV_TAG=$(git tag --sort=-v:refname | grep -A1 "^v${VERSION}$" | tail -1)
  NOTES=$(release_notes "$PREV_TAG")

  gh release create "v${VERSION}" --title "v${VERSION}" --notes "$NOTES"
  info "GitHub release created (notes from CHANGELOG.md [${VERSION}])"
fi

# =============================================================================
# Step 8: Publish to the Official MCP Registry
# =============================================================================
# Downstream catalogs (Glama, PulseMCP, mcpservers.org) auto-source from the
# Official MCP Registry; publishing here is what makes the new version visible
# to them. server.json was already bumped in step 4 so the version matches the
# tag.
step 8 "Publish to MCP Registry"

if [ ! -f server.json ]; then
  info "No server.json -- not an MCP server, skipping registry publish"
else
  # mcp-publisher binary cached at ~/.local/bin. Pinned to "latest" upstream;
  # if the registry's CLI introduces a breaking change, the next release will
  # surface it. The OS/arch detection handles Linux, macOS, and Git Bash on
  # Windows (MINGW/MSYS uname -s starts with "mingw" / "msys").
  MP="${MCP_PUBLISHER:-$HOME/.local/bin/mcp-publisher}"
  if ! [ -x "$MP" ]; then
    info "mcp-publisher not found at $MP -- downloading"
    mkdir -p "$(dirname "$MP")"
    OS_RAW=$(uname -s | tr '[:upper:]' '[:lower:]')
    case "$OS_RAW" in mingw*|msys*|cygwin*) OS=windows ;; *) OS="$OS_RAW" ;; esac
    ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
    TMP=$(mktemp -d)
    curl -sL -o "$TMP/mp.tar.gz" \
      "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_${OS}_${ARCH}.tar.gz" \
      || fail "Failed to download mcp-publisher (${OS}/${ARCH})"
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
  # we use a GitHub PAT via `login github -token <PAT>`. The PAT needs read:org
  # for YawLabs so the registry can verify org membership for the
  # io.github.YawLabs/* namespace.
  # Fall back to gh CLI's session token if MCP_REGISTRY_TOKEN is unset --
  # gh auth login (admin:org or read:org scope) covers the namespace claim.
  : "${MCP_REGISTRY_TOKEN:=$(gh auth token 2>/dev/null || true)}"
  if [ -z "${MCP_REGISTRY_TOKEN:-}" ]; then
    fail "MCP_REGISTRY_TOKEN unset -- set it to a GitHub PAT with read:org for YawLabs (or run '$MP login github' once interactively to cache the session)."
  fi
  "$MP" login github -token "$MCP_REGISTRY_TOKEN" >/dev/null 2>&1 \
    || fail "mcp-publisher login failed -- check MCP_REGISTRY_TOKEN scopes (needs read:org for YawLabs)"

  # npm propagation gate. npm accepts a publish and then takes ~30-90s to serve
  # the new version ("Your package is being processed and may take a few
  # minutes to become available"). Until it does, the MCP Registry rejects the
  # publish with HTTP 400 "NPM package '@yawlabs/ctxlint' exists, but version
  # 'X.Y.Z' was not found (status: 404)" -- which is what killed the v0.25.0
  # run with npm AND the GitHub release already landed, and step 9 never
  # reached.
  #
  # 20 x 6s -- twice the CI-publish poll in step 6 -- and placed HERE rather
  # than in one of step 6's branches so it covers every path into step 8:
  # workstation publish, CI publish, and a resume run whose publish happened in
  # an earlier invocation. A poll that runs out does not fail -- it warns and
  # lets the publish speak, since the retry below is the real backstop.
  #
  # Why 120s: the 60s this used to be was exhausted by the v0.27.0 run
  # (2026-09-13), which then needed the LAST of the three retries below, about
  # 150s after the publish -- while v0.25.4 the same day cleared the poll in
  # under 60s. The waits only elapse on a run that is still propagating.
  NPM_POLLS=20
  NPM_SERVING=false
  for ((i = 1; i <= NPM_POLLS; i++)); do
    if npm_version_live; then NPM_SERVING=true; break; fi
    [ "$i" -eq 1 ] && info "Waiting for npm to serve v${VERSION} before registering it (up to $((NPM_POLLS * 6))s)"
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
  MCP_FAIL_MSG="mcp-publisher publish failed for v${VERSION}. ALREADY LANDED: npm @yawlabs/ctxlint@${VERSION} and GitHub release v${VERSION} -- ONLY the MCP Registry entry is missing, so do NOT re-run this script. Fix the cause, then complete just this step with: ${MCP_FIX_CMD}"

  # Four attempts, spaced 30s, 60s, then 90s (180s in all), and ONLY for the
  # propagation shape.
  #
  # Why more than one retry: the gate above reads npm from this machine's CDN
  # edge, so it can go green while the registry's own view still lags. Going
  # green early is what SHRINKS the budget -- a single 30s retry would cover
  # barely a third of the 30-90s window npm itself quotes. The waits only
  # elapse on a run that is already failing. The fourth attempt is the margin
  # the v0.27.0 run (2026-09-13) had none of: it succeeded on attempt 3 of 3.
  #
  # Every other failure -- bad server.json, namespace not owned, auth -- fails
  # identically after any wait, so it exits on the first attempt rather than
  # buying a silent 90s. The version has to appear in the SAME output as the
  # not-found text, or an unrelated "was not found" would buy those waits too.
  MCP_PUBLISH_LOG=$(mktemp)
  MCP_DONE=false
  MCP_ATTEMPT=1
  MCP_MAX_ATTEMPTS=4
  while true; do
    if "$MP" publish 2>&1 | tee "$MCP_PUBLISH_LOG"; then
      MCP_DONE=true
      break
    fi
    # Already registered -- the state a resume run lands in, and success for
    # this step's purpose. The script's header promises each step is
    # idempotent, and without this a re-verify run would exit 1 claiming the
    # registry entry is missing when it is the one thing that IS there.
    if grep -qiE 'duplicate version|already exists' "$MCP_PUBLISH_LOG"; then
      info "MCP Registry already has ${VERSION} -- nothing to publish"
      MCP_DONE=true
      break
    fi
    # Not the propagation shape, or out of attempts.
    if ! { grep -qE 'was not found|status: *404' "$MCP_PUBLISH_LOG" && grep -qF "$VERSION" "$MCP_PUBLISH_LOG"; }; then
      break
    fi
    if [ "$MCP_ATTEMPT" -ge "$MCP_MAX_ATTEMPTS" ]; then break; fi
    MCP_WAIT=$((MCP_ATTEMPT * 30))
    warn "MCP Registry cannot see @yawlabs/ctxlint@${VERSION} on npm yet -- waiting ${MCP_WAIT}s, then attempt $((MCP_ATTEMPT + 1)) of ${MCP_MAX_ATTEMPTS}"
    sleep "$MCP_WAIT"
    MCP_ATTEMPT=$((MCP_ATTEMPT + 1))
  done
  rm -f "$MCP_PUBLISH_LOG"
  if [ "$MCP_DONE" = "true" ]; then
    info "Published to MCP Registry"
  else
    fail "$MCP_FAIL_MSG"
  fi
fi

# =============================================================================
# Step 9: Verify
# =============================================================================
step 9 "Verify"

# Wait a moment for npm registry to propagate
sleep 3

NPM_VERSION=$(npm view @yawlabs/ctxlint version 2>/dev/null || echo "")
if [ "$NPM_VERSION" = "$VERSION" ]; then
  info "npm: @yawlabs/ctxlint@${NPM_VERSION}"
else
  warn "npm shows ${NPM_VERSION:-nothing} (expected $VERSION — may still be propagating)"
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
