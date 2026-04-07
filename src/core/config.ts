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
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as CtxlintConfig;
    } catch {
      continue;
    }
  }
  return null;
}
