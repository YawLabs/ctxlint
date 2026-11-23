import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripBom } from '../../utils/fs.js';

/**
 * Shared reader for `.github/workflows/*.yml|yaml`, used by the ci-coverage and
 * ci-secrets checks so the two enumerate and decode workflow files the same way.
 */

export interface WorkflowFile {
  /** Basename, e.g. `release.yml`. */
  name: string;
  /** File content with the BOM stripped and CRLF/CR normalised to LF. */
  content: string;
}

/**
 * Read every workflow file under `<projectRoot>/.github/workflows`, sorted by
 * name so findings that list workflows are deterministic. A missing directory
 * yields `[]`; an unreadable file is skipped.
 */
export async function readWorkflowFiles(projectRoot: string): Promise<WorkflowFile[]> {
  const workflowDir = join(projectRoot, '.github', 'workflows');
  let entries: string[];
  try {
    entries = await readdir(workflowDir);
  } catch {
    return [];
  }

  const out: WorkflowFile[] = [];
  for (const name of entries.sort()) {
    if (!(name.endsWith('.yml') || name.endsWith('.yaml'))) continue;
    try {
      const raw = stripBom(await readFile(join(workflowDir, name), 'utf-8'));
      out.push({ name, content: raw.replace(/\r\n?/g, '\n') });
    } catch {
      // skip unreadable files (or a directory named *.yml)
    }
  }
  return out;
}

/**
 * The workflow's top-level `name:` value, or undefined when it has none.
 *
 * "Top-level" means at the indentation of the document's first mapping key,
 * not column 0: a workflow whose keys are all uniformly indented is still
 * valid YAML. A `name:` nested deeper (a step's `with: { name: ... }`, a job
 * name) is never the workflow's name. Surrounding quotes and a trailing
 * ` # comment` are stripped. Block-scalar names (`name: >`) are not resolved --
 * vanishingly rare for a workflow name.
 */
export function topLevelWorkflowName(content: string): string | undefined {
  let topIndent: number | undefined;
  for (const line of content.split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (topIndent === undefined) topIndent = indent;
    if (indent !== topIndent) continue;
    const m = /^\s*name:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[1];
    const quoted = /^(['"])(.*)\1(?:\s+#.*)?$/.exec(value);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '');
    return value;
  }
  return undefined;
}
