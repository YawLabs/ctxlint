import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ParsedContextFile, LintIssue } from '../types.js';

// Workflow filenames or YAML `name:` values that indicate release/deploy workflows
const RELEASE_FILENAME_PATTERNS = [/release/i, /deploy/i, /publish/i, /\bcd\b/i];

// Phrases in context files that indicate release/deploy documentation
const RELEASE_DOC_PATTERNS = [
  /release\s+(process|workflow|steps|via|by|using)/i,
  /deploy\s+(process|workflow|steps|to|via|using)/i,
  /publish\s+(to|via|using|workflow|process)/i,
  /push\s+(?:a\s+)?(?:v[\d.]+ )?tag/i,
  /git\s+tag\s+v/i,
  /npm\s+publish/i,
  /release\.yml/i,
  /deploy\.yml/i,
  /ci\/cd\s+pipeline/i,
  /continuous\s+deploy/i,
];

async function findReleaseWorkflows(projectRoot: string): Promise<string[]> {
  const workflowDir = join(projectRoot, '.github', 'workflows');
  if (!existsSync(workflowDir)) return [];

  let files: string[];
  try {
    files = await readdir(workflowDir);
  } catch {
    return [];
  }

  const releaseWorkflows: string[] = [];

  for (const f of files) {
    if (!(f.endsWith('.yml') || f.endsWith('.yaml'))) continue;

    // Check filename
    if (RELEASE_FILENAME_PATTERNS.some((p) => p.test(f))) {
      releaseWorkflows.push(f);
      continue;
    }

    // Check YAML `name:` field for release-related names
    try {
      const content = await readFile(join(workflowDir, f), 'utf-8');
      const nameMatch = content.match(/^name:\s*(.+)$/m);
      if (nameMatch && RELEASE_FILENAME_PATTERNS.some((p) => p.test(nameMatch[1]))) {
        releaseWorkflows.push(f);
      }
    } catch {
      // skip unreadable files
    }
  }

  return releaseWorkflows;
}

function contextMentionsRelease(files: ParsedContextFile[]): boolean {
  for (const file of files) {
    for (const pattern of RELEASE_DOC_PATTERNS) {
      if (pattern.test(file.content)) return true;
    }
  }
  return false;
}

/**
 * Flag when .github/workflows has release/deploy workflows but no context file
 * documents the release process. Agents will guess and loop without this info.
 */
export async function checkCiCoverage(
  files: ParsedContextFile[],
  projectRoot: string,
): Promise<LintIssue[]> {
  const releaseWorkflows = await findReleaseWorkflows(projectRoot);
  if (releaseWorkflows.length === 0) return [];
  if (contextMentionsRelease(files)) return [];

  return [
    {
      severity: 'info',
      check: 'ci-coverage',
      ruleId: 'ci/no-release-docs',
      line: 0,
      message: `Release workflow${releaseWorkflows.length > 1 ? 's' : ''} found (${releaseWorkflows.join(', ')}) but no context file documents the release process`,
      suggestion:
        'Document how releases work (e.g. "push a v* tag to trigger CI") in a context file so agents don\'t guess',
    },
  ];
}
