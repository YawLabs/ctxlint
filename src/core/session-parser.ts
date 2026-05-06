import { readFile } from 'node:fs/promises';
import type { MemoryEntry } from './types.js';
import { stripBom } from '../utils/fs.js';

// Two passes:
//   PATH_PATTERN matches paths that start with a leading marker (`.`, `..`,
//     `~`, `/`). The leading marker lets us be permissive about everything
//     after it without dragging in arbitrary `Foo/Bar` prose tokens.
//   BARE_FILE_PATH catches relative paths *without* a leading marker --
//     `src/api/client.ts` style. We require BOTH a `/` and a recognizable
//     file extension to keep prose tokens (`I/O`, `n/a`, `Vitest/Jest`) out.
const PATH_PATTERN = /(?:^|\s|['"`(])([.~/][^\s'"`),;:!?]+)/g;
const BARE_FILE_PATH = /(?:^|[\s`"'(])([\w][\w-]*(?:\/[\w.-]+)+\.[a-zA-Z0-9]{1,8})\b/g;

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

/**
 * Extract file path references from memory file content.
 *
 * Two passes (see PATH_PATTERN / BARE_FILE_PATH for rationale): leading-marker
 * paths (`./`, `../`, `~/`, `/`) plus bare relative paths that have BOTH a
 * `/` and a file extension (`src/api/client.ts`). Anything weaker -- a single
 * slash with no extension -- stays out so `I/O`, `n/a`, and `Vitest/Jest`
 * prose don't pollute the stale-memory check.
 */
export function extractPaths(content: string): string[] {
  const paths: string[] = [];
  for (const match of content.matchAll(PATH_PATTERN)) {
    const p = match[1].replace(/[)}\]]+$/, ''); // trim trailing brackets
    if (p.length > 2 && !p.startsWith('http') && !p.startsWith('//')) {
      paths.push(p);
    }
  }
  for (const match of content.matchAll(BARE_FILE_PATH)) {
    const p = match[1].replace(/[)}\]]+$/, '');
    if (p.length > 2 && !p.startsWith('http')) {
      paths.push(p);
    }
  }
  return [...new Set(paths)];
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
