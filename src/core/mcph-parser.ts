import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseTree, type Node } from 'jsonc-parser';
import { readFileContent } from '../utils/fs.js';
import { getGit } from '../utils/git.js';
import type { ParsedMchpConfig, MchpConfigScope, MchpFieldPosition } from './types.js';
import type { DiscoveredFile } from './scanner.js';

const KNOWN_FIELDS = new Set(['$schema', 'version', 'token', 'apiBase', 'servers', 'blocked']);

export async function parseMchpConfig(
  file: DiscoveredFile,
  projectRoot: string,
  scopeOverride?: MchpConfigScope,
): Promise<ParsedMchpConfig> {
  const content = readFileContent(file.absolutePath);
  const scope = scopeOverride ?? detectScope(file.relativePath);
  const isGitTracked = await checkGitTracked(file.absolutePath, projectRoot);
  const isGitignored = checkGitignored(file.absolutePath, projectRoot);

  const result: ParsedMchpConfig = {
    filePath: file.absolutePath,
    relativePath: file.relativePath,
    scope,
    content,
    parseErrors: [],
    isGitTracked,
    isGitignored,
    raw: null,
    positions: {},
    listEntries: { servers: [], blocked: [] },
    unknownFields: [],
  };

  // Parse as JSONC (comments allowed, per the mcph CLI spec).
  const errors: { error: number; offset: number; length: number }[] = [];
  const tree = parseTree(content, errors, { allowTrailingComma: true });

  if (errors.length > 0 || !tree) {
    for (const e of errors) {
      const { line, column } = offsetToPosition(content, e.offset);
      result.parseErrors.push(`Parse error at ${line}:${column} (code ${e.error})`);
    }
    return result;
  }

  if (tree.type !== 'object') {
    result.parseErrors.push('.mcph.json must be a JSON object at the root');
    return result;
  }

  // Build raw object from the tree.
  try {
    result.raw = JSON.parse(stripComments(content));
  } catch {
    // Defensive: parseTree succeeded but JSON.parse didn't (unlikely).
    return result;
  }

  // Walk top-level properties to capture positions for each known field and
  // flag unknown ones.
  const rootProps = tree.children ?? [];
  for (const prop of rootProps) {
    if (prop.type !== 'property' || !prop.children || prop.children.length < 2) continue;
    const keyNode = prop.children[0];
    const valueNode = prop.children[1];
    if (keyNode.type !== 'string' || typeof keyNode.value !== 'string') continue;

    const name = keyNode.value;
    const position = nodePosition(content, keyNode);

    if (KNOWN_FIELDS.has(name)) {
      result.positions[name as keyof typeof result.positions] = position;

      if (name === 'servers' || name === 'blocked') {
        if (valueNode.type === 'array' && valueNode.children) {
          for (const item of valueNode.children) {
            if (item.type === 'string' && typeof item.value === 'string') {
              result.listEntries[name].push({
                value: item.value,
                position: nodePosition(content, item),
              });
            }
          }
        }
      }
    } else {
      result.unknownFields.push({ name, position });
    }
  }

  return result;
}

function detectScope(relativePath: string): MchpConfigScope {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('~/')) return 'global';
  if (normalized.endsWith('.mcph.local.json')) return 'project-local';
  return 'project';
}

function nodePosition(content: string, node: Node): MchpFieldPosition {
  const start = offsetToPosition(content, node.offset);
  const end = offsetToPosition(content, node.offset + node.length);
  return {
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
  };
}

function offsetToPosition(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

// Strip line + block comments for the JSON.parse fallback. jsonc-parser's
// parseTree already handled positions; this is only to get a plain object.
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let escape = false;
  while (i < src.length) {
    const ch = src[i];
    if (inString) {
      out += ch;
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

async function checkGitTracked(filePath: string, projectRoot: string): Promise<boolean> {
  try {
    const git = getGit(projectRoot);
    const result = await git.raw(['ls-files', '--error-unmatch', filePath]);
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

function checkGitignored(filePath: string, projectRoot: string): boolean {
  // A file is "gitignored" if it's inside the project and matches a
  // .gitignore rule. We approximate by reading .gitignore and checking
  // path/basename matches — good enough for the two filenames we care about
  // (.mcph.json, .mcph.local.json), both of which are typically ignored by
  // literal name.
  const gitignorePath = path.join(projectRoot, '.gitignore');
  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    return false;
  }
  const basename = path.basename(filePath);
  const patterns = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  return patterns.some((p) => p === basename || p === `/${basename}` || p === `./${basename}`);
}
