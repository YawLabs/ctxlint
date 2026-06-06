import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryEntry } from './types.js';
import { stripBom } from '../utils/fs.js';

declare const __WEB_FIRST_SEGMENTS__: string[] | undefined;

/**
 * First-segment vocabulary used by `classifyPath` to distinguish URL paths
 * (/blog, /docs, /api/...) from filesystem paths. Source of truth lives at
 * `tests/fixtures/web-first-segments.json` so additions go through a fixture
 * edit + a test, not a code edit.
 *
 * Two load paths mirror `version.ts`:
 *   - Bundled by esbuild: `__WEB_FIRST_SEGMENTS__` is replaced at build time
 *     with the fixture contents inlined as a literal.
 *   - Unbundled in vitest: read the fixture from disk via `import.meta.url`.
 */
function loadWebFirstSegments(): Set<string> {
  if (typeof __WEB_FIRST_SEGMENTS__ !== 'undefined') {
    return new Set(__WEB_FIRST_SEGMENTS__);
  }
  const __dir = dirname(fileURLToPath(import.meta.url));
  const fixturePath = resolve(__dir, '../../tests/fixtures/web-first-segments.json');
  const raw = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  const list: string[] = Array.isArray(raw) ? raw : raw.segments;
  return new Set(list);
}

const WEB_FIRST_SEGMENTS: Set<string> = loadWebFirstSegments();

// Three passes:
//   PATH_PATTERN matches paths that start with a leading marker (`.`, `..`,
//     `~`, `/`). The leading marker lets us be permissive about everything
//     after it without dragging in arbitrary `Foo/Bar` prose tokens.
//   BARE_FILE_PATH catches relative paths *without* a leading marker --
//     `src/api/client.ts` style. We require BOTH a `/` and a recognizable
//     file extension to keep prose tokens (`I/O`, `n/a`, `Vitest/Jest`) out.
//   DRIVE_ABS_PATH catches Windows drive-absolute paths in both forms
//     (`C:/Users/...` and `C:\Users\...`). The other two passes can't reach
//     these: PATH_PATTERN requires a `[.~/]` leading marker and excludes `:`,
//     and BARE_FILE_PATH's `[\w-]*` run dies at the drive colon before the
//     required `/`. We anchor on the strict `<letter>:<sep>` drive shape so
//     prose colons (`note:`, `n/a`) don't match.
const PATH_PATTERN = /(?:^|\s|['"`(])([.~/][^\s'"`),;:!?]+)/g;
const BARE_FILE_PATH = /(?:^|[\s`"'(])([\w][\w-]*(?:\/[\w.-]+)+\.[a-zA-Z0-9]{1,8})\b/g;
const DRIVE_ABS_PATH = /(?:^|[\s`"'(])([A-Za-z]:[\\/][^\s'"`),;!?]+)/g;

/**
 * Encode a filesystem path the same way Claude Code encodes project directory names.
 * Claude replaces `:`, `/`, `\`, and `.` with `-`.
 * Example: "C:/Users/jeff/yaw/ctxlint" -> "C--Users-jeff-yaw-ctxlint"
 *
 * Note: this encoding is lossy — hyphens, dots, and path separators all map
 * to `-`. We use this for matching (encoded == encoded) rather than decoding.
 */
export function encodeProjectDir(fsPath: string): string {
  return fsPath.replace(/[:\\/\.]/g, '-');
}

/**
 * Check whether an encoded Claude project directory name matches a filesystem path.
 * Avoids the ambiguity of trying to decode `-` back to `/`, `-`, or `.`.
 */
export function projectDirMatchesPath(encodedDir: string, fsPath: string): boolean {
  const normalized = fsPath.replace(/\\/g, '/');
  return encodedDir === encodeProjectDir(normalized);
}

export type PathClass = 'fs-path' | 'slash-command' | 'url-path' | 'approximation' | 'template';

export interface ClassifiedPath {
  value: string;
  class: PathClass;
}

/**
 * Reject candidates that look path-like but aren't filesystem paths.
 * Order matters: cheaper / more specific rules first.
 *
 * The two regexes above are a cheap first-pass filter that captures anything
 * starting with `.`, `~`, `/` (PATH_PATTERN) or a bare `dir/file.ext` shape
 * (BARE_FILE_PATH). That filter happily eats slash-commands, tilde
 * approximations, URL paths, and template placeholders -- this classifier is
 * the second-pass gate that keeps those out of `extractPaths`.
 */
export function classifyPath(p: string, contextHints?: { baseUrls?: string[] }): PathClass {
  // 1. Approximation: ~ followed by a digit, optionally with a unit suffix.
  //    Matches: ~80%, ~23h, ~600, ~1KB, ~1.5x, ~Nx
  //    Does NOT match: ~/.bashrc, ~/projects/foo
  if (/^~(?:\d|[A-Z](?=[a-z]?(?:x|\b)))/.test(p)) return 'approximation';

  // 2. Template placeholder: contains <...> or {{...}} -- never a real path.
  //    Matches: ~/.claude/skills/<name>/SKILL.md, src/{{module}}/index.ts
  if (/<[^>]+>|\{\{[^}]+\}\}/.test(p)) return 'template';

  // 3. URL path: starts with /, no file extension, AND either the first
  //    segment is in the known-web-first-segments set OR a base URL appears
  //    in the surrounding memory. Runs BEFORE the slash-command rule because
  //    single-segment URL paths (/blog, /docs) also match the slash-command
  //    regex; whichever check runs first wins, and the URL-path signal is
  //    the stronger one (explicit vocabulary or explicit base-URL hint).
  if (p.startsWith('/')) {
    const hasExt = /\.[a-zA-Z0-9]{1,8}$/.test(p);
    if (!hasExt) {
      const firstSeg = p.slice(1).split('/')[0];
      if (WEB_FIRST_SEGMENTS.has(firstSeg)) return 'url-path';
      if (contextHints?.baseUrls?.length) return 'url-path';
    }
  }

  // 4. Slash command: starts with /, has exactly one path segment (no inner /),
  //    no file extension, all-kebab or all-snake. Matches /yaw-review,
  //    /release-yaw, /yaw-session-audit. Does NOT match /var/log/app.log.
  if (/^\/[a-z][a-z0-9_-]*$/.test(p)) return 'slash-command';

  return 'fs-path';
}

/**
 * Internal helper: scan content for path-like candidates and return each with
 * its classification. Not exported from the package (no entry in `index.ts`)
 * -- exists for future detectors (URL-staleness, template-validity) and for
 * debug tooling. Public callers should keep using `extractPaths`.
 */
export function extractPathsClassified(content: string): ClassifiedPath[] {
  const baseUrls = [...content.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
  const hints = { baseUrls };

  const candidates: string[] = [];
  for (const match of content.matchAll(PATH_PATTERN)) {
    const p = match[1].replace(/[)}\]]+$/, '');
    if (p.length > 2 && !p.startsWith('http') && !p.startsWith('//')) {
      candidates.push(p);
    }
  }
  for (const match of content.matchAll(BARE_FILE_PATH)) {
    const p = match[1].replace(/[)}\]]+$/, '');
    if (p.length > 2 && !p.startsWith('http')) {
      candidates.push(p);
    }
  }
  for (const match of content.matchAll(DRIVE_ABS_PATH)) {
    const p = match[1].replace(/[)}\]]+$/, '');
    if (p.length > 2) {
      candidates.push(p);
    }
  }

  const seen = new Set<string>();
  const out: ClassifiedPath[] = [];
  for (const value of candidates) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ value, class: classifyPath(value, hints) });
  }
  return out;
}

/**
 * Extract file path references from memory file content.
 *
 * Two passes (see PATH_PATTERN / BARE_FILE_PATH for rationale): leading-marker
 * paths (`./`, `../`, `~/`, `/`) plus bare relative paths that have BOTH a
 * `/` and a file extension (`src/api/client.ts`). Anything weaker -- a single
 * slash with no extension -- stays out so `I/O`, `n/a`, and `Vitest/Jest`
 * prose don't pollute the stale-memory check.
 *
 * Each candidate is then run through `classifyPath` and only `'fs-path'`
 * candidates are returned. Other classes (slash-command, url-path,
 * approximation, template) are dropped silently to keep `session-stale-memory`
 * focused on real filesystem references.
 */
export function extractPaths(content: string): string[] {
  return extractPathsClassified(content)
    .filter((c) => c.class === 'fs-path')
    .map((c) => c.value);
}

/**
 * Parse YAML frontmatter from a memory markdown file.
 * Returns the frontmatter fields and the body content.
 */
export function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  type?: string;
  body: string;
} {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    return { body: content };
  }

  const endIdx = lines.indexOf('---', 1);
  if (endIdx === -1) {
    return { body: content };
  }

  const frontmatter: Record<string, string> = {};
  for (let i = 1; i < endIdx; i++) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      frontmatter[key] = value;
    }
  }

  return {
    name: frontmatter['name'],
    description: frontmatter['description'],
    type: frontmatter['type'],
    body: lines.slice(endIdx + 1).join('\n'),
  };
}

/**
 * Parse a Claude Code memory file into a MemoryEntry.
 */
export async function parseMemoryFile(filePath: string, projectDir: string): Promise<MemoryEntry> {
  const content = stripBom(await readFile(filePath, 'utf-8'));
  const { name, description, type, body } = parseFrontmatter(content);
  const referencedPaths = extractPaths(body);

  return {
    filePath,
    projectDir,
    name,
    description,
    type,
    content: body,
    referencedPaths,
  };
}
