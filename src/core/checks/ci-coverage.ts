import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ParsedContextFile, LintIssue } from '../types.js';
import { stripBom } from '../../utils/fs.js';

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

    // Check YAML `name:` field for release-related names. Allow optional
    // leading whitespace (a `name:` nested under another key, or just an
    // indented top-level key) and strip surrounding single/double quotes from
    // the captured value (`name: "Release"` / `name: 'Release'`). This stays a
    // line regex rather than a full YAML parse on purpose -- the one shape it
    // still can't see is a block scalar (`name: >` / `name: |` with the value
    // on the following indented line), which is vanishingly rare for a
    // workflow name and would require real YAML parsing to resolve.
    try {
      const content = stripBom(await readFile(join(workflowDir, f), 'utf-8'));
      const nameMatch = content.match(/^\s*name:\s*(.+?)\s*$/m);
      if (nameMatch) {
        const name = nameMatch[1].replace(/^(['"])(.*)\1$/, '$2');
        if (RELEASE_FILENAME_PATTERNS.some((p) => p.test(name))) {
          releaseWorkflows.push(f);
        }
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
      ruleId: 'ci-coverage/no-release-docs',
      line: 0,
      message: `Release workflow${releaseWorkflows.length > 1 ? 's' : ''} found (${releaseWorkflows.join(', ')}) but no context file documents the release process`,
      suggestion:
        'Document how releases work (e.g. "push a v* tag to trigger CI") in a context file so agents don\'t guess',
    },
  ];
}
