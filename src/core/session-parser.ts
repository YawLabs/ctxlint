import { readFile } from 'node:fs/promises';
import type { MemoryEntry } from './types.js';

const PATH_PATTERN = /(?:^|\s|['"`(])([.~/][^\s'"`),;:!?]+)/g;

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
 */
export function extractPaths(content: string): string[] {
  const paths: string[] = [];
  for (const match of content.matchAll(PATH_PATTERN)) {
    const p = match[1].replace(/[)}\]]+$/, ''); // trim trailing brackets
    if (p.length > 2 && !p.startsWith('http') && !p.startsWith('//')) {
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
  const content = await readFile(filePath, 'utf-8');
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
