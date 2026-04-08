import { readFile } from 'node:fs/promises';
import type { MemoryEntry } from './types.js';

const PATH_PATTERN = /(?:^|\s|['"`(])([.~/][^\s'"`),;:!?]+)/g;

/**
 * Decode a Claude Code project directory name to a filesystem path.
 * Example: "C--Users-jeff-yaw-ctxlint" -> "C:/Users/jeff/yaw/ctxlint"
 */
export function decodeProjectDir(dirName: string): string {
  // Claude uses -- as path separator in directory names
  // First char + colon pattern for Windows drives: "C--" -> "C:/"
  const parts = dirName.split('--');
  if (parts.length <= 1) return dirName;

  // Check for Windows drive letter pattern (single letter first part)
  if (parts[0].length === 1 && /^[A-Z]$/i.test(parts[0])) {
    return parts[0] + ':/' + parts.slice(1).join('/');
  }

  return '/' + parts.join('/');
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
export async function parseMemoryFile(
  filePath: string,
  projectDir: string,
): Promise<MemoryEntry> {
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
