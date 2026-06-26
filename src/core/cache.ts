import type { LintIssue, ParsedContextFile } from './types.js';

interface CacheEntry {
  mtime: number;
  size: number;
  parseResult: ParsedContextFile;
  issues: LintIssue[]; // single-file check results only
}

const fileCache = new Map<string, CacheEntry>();

export function getCacheEntry(absolutePath: string): CacheEntry | undefined {
  return fileCache.get(absolutePath);
}

export function setCacheEntry(absolutePath: string, entry: CacheEntry): void {
  fileCache.set(absolutePath, entry);
}

export function clearFileCache(): void {
  fileCache.clear();
}
