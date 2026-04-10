import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CheckName } from './types.js';

export interface CtxlintConfig {
  checks?: CheckName[];
  ignore?: CheckName[];
  strict?: boolean;
  tokenThresholds?: {
    info?: number;
    warning?: number;
    error?: number;
    aggregate?: number;
  };
  contextFiles?: string[];
  mcp?: boolean;
  mcpGlobal?: boolean;
}

const CONFIG_FILENAMES = ['.ctxlintrc', '.ctxlintrc.json'];

export function loadConfig(projectRoot: string): CtxlintConfig | null {
  for (const filename of CONFIG_FILENAMES) {
    const filePath = path.join(projectRoot, filename);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue; // file doesn't exist, try next
    }
    // File exists — parse errors should be reported
    try {
      return JSON.parse(content) as CtxlintConfig;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON in ${filePath}: ${msg}`);
    }
  }
  return null;
}
