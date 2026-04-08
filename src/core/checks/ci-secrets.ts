import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { ParsedContextFile, LintIssue } from '../types.js';

// GitHub-provided secrets that don't need documentation
const BUILTIN_SECRETS = new Set([
  'GITHUB_TOKEN',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'ACTIONS_CACHE_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RESULTS_URL',
]);

const SECRETS_REGEX = /\$\{\{\s*secrets\.(\w+)\s*\}\}/g;

interface SecretUsage {
  name: string;
  workflows: string[];
}

async function findSecretUsages(projectRoot: string): Promise<SecretUsage[]> {
  const workflowDir = join(projectRoot, '.github', 'workflows');
  if (!existsSync(workflowDir)) return [];

  let files: string[];
  try {
    files = await readdir(workflowDir);
  } catch {
    return [];
  }

  const secretMap = new Map<string, string[]>();

  for (const f of files) {
    if (!(f.endsWith('.yml') || f.endsWith('.yaml'))) continue;

    let content: string;
    try {
      content = await readFile(join(workflowDir, f), 'utf-8');
    } catch {
      continue;
    }

    let match;
    const regex = new RegExp(SECRETS_REGEX.source, 'g');
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (BUILTIN_SECRETS.has(name)) continue;
      if (!secretMap.has(name)) secretMap.set(name, []);
      if (!secretMap.get(name)!.includes(f)) secretMap.get(name)!.push(f);
    }
  }

  return [...secretMap.entries()].map(([name, workflows]) => ({ name, workflows }));
}

function contextMentionsSecret(files: ParsedContextFile[], secretName: string): boolean {
  const pattern = new RegExp(secretName.replace(/_/g, '[_\\s-]?'), 'i');
  return files.some((f) => pattern.test(f.content));
}

/**
 * Parse CI workflows for ${{ secrets.X }} references and flag any that
 * aren't mentioned in context files. Undocumented secrets cause agents
 * to guess at token/auth setup and loop.
 */
export async function checkCiSecrets(
  files: ParsedContextFile[],
  projectRoot: string,
): Promise<LintIssue[]> {
  const usages = await findSecretUsages(projectRoot);
  if (usages.length === 0) return [];

  const issues: LintIssue[] = [];

  for (const { name, workflows } of usages) {
    if (contextMentionsSecret(files, name)) continue;

    issues.push({
      severity: 'info',
      check: 'ci-secrets',
      ruleId: 'ci/undocumented-secret',
      line: 0,
      message: `CI secret "${name}" is used in ${workflows.join(', ')} but not mentioned in any context file`,
      suggestion: `Document what ${name} is and how to set it (e.g. "gh secret set ${name}") so agents don't create new tokens or guess`,
    });
  }

  return issues;
}
