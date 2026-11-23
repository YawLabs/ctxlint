import type { ParsedContextFile, LintIssue } from '../types.js';
import { readWorkflowFiles, topLevelWorkflowName } from './workflow-files.js';

// Workflow filenames or top-level YAML `name:` values that indicate
// release/deploy workflows
const RELEASE_FILENAME_PATTERNS = [/release/i, /deploy/i, /publish/i, /\bcd\b/i];

// Word stems, so "Releases are cut", "Releasing via", "Deploys to", "Deployment
// is handled", "publishes to" all count -- not just the bare verb.
const RELEASE_STEM = String.raw`releas(?:e|es|ed|ing)`;
const DEPLOY_STEM = String.raw`deploy(?:s|ed|ing|ments?)?`;
const PUBLISH_STEM = String.raw`publish(?:es|ed|ing)?`;

// A copula only counts when a verb follows it: "Releases are cut with...",
// "Deployment is handled by...", but not "Release notes are in CHANGELOG" or
// "The release is on Friday".
const COPULA_VERB = String.raw`(?:are|is)\s+(?:\w+ly\s+)?(?:cut|made|done|handled|triggered|automated|published|deployed|run|built|created|tagged|managed|performed|shipped|driven|kicked)`;

// "Never push a tag", "Don't push tags", "do not push": a negated instruction
// is not a description of how the release happens.
const NOT_NEGATED = String.raw`(?<!\b(?:not|never|no|don['’]t|dont|doesn['’]t)\s+)`;

// Phrases in context files that indicate release/deploy documentation. Each
// stem needs a following word that makes it a statement about HOW the
// release/deploy happens, so a passing "see the release notes" does not count.
const RELEASE_DOC_PATTERNS = [
  // A heading about the release/deploy process: "## Releasing", "## Deploying
  // to Fly", "## Deployment", "### Release process". Not "## Release notes" or
  // "## Deployment targets", which describe something else.
  /^#{1,6}\s+(?:.*\s)?(?:releasing|deploying|publishing|deployment)\b(?!\s+(?:notes?|targets?|environments?|history|log|status)\b)/im,
  /^#{1,6}\s+(?:.*\s)?(?:release|deploy|deployment|publish(?:ing)?)\s+(?:process|workflow|steps|procedure|guide|flow)\b/im,
  new RegExp(
    String.raw`\b${RELEASE_STEM}\s+(?:process|workflow|steps|via|by|using|with|happens?|runs?|automatically|${COPULA_VERB})\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b${DEPLOY_STEM}\s+(?:process|workflow|steps|to|via|by|using|with|happens?|runs?|automatically|${COPULA_VERB})\b`,
    'i',
  ),
  new RegExp(
    String.raw`\b${PUBLISH_STEM}\s+(?:to|via|by|using|with|automatically|workflow|process|${COPULA_VERB})\b`,
    'i',
  ),
  // "push a v* tag", "push a v1.2.3 tag", "push the release tag": any one
  // token may sit between the article and "tag" -- except "to" ("push to
  // tag-protected branches" is about branches) -- and the push is not negated.
  new RegExp(
    String.raw`${NOT_NEGATED}\bpush(?:es|ed|ing)?\s+(?:(?:a|an|the)\s+)?(?:(?!to\b)\S+\s+)?tags?\b`,
    'i',
  ),
  new RegExp(String.raw`${NOT_NEGATED}\btag\s+push`, 'i'),
  /\bgit\s+tag\s+v/i,
  /\bnpm\s+publish/i,
  /\bnpm\s+version\s+(?:patch|minor|major|pre\w*|\d)/i,
  /--follow-tags\b/i,
  /\brelease\.(?:sh|ps1|mjs|cjs|js|ts|py)\b/i,
  /release\.ya?ml/i,
  /deploy\.ya?ml/i,
  /ci\/cd\s+pipeline/i,
  /continuous\s+deploy/i,
];

async function findReleaseWorkflows(projectRoot: string): Promise<string[]> {
  const releaseWorkflows: string[] = [];
  for (const { name: f, content } of await readWorkflowFiles(projectRoot)) {
    // Check filename, then the workflow's own top-level `name:`. Only the
    // top-level key is the workflow name -- a nested `name:` (a step's
    // `with: { name: release-build }`) says nothing about what the workflow
    // does.
    if (RELEASE_FILENAME_PATTERNS.some((p) => p.test(f))) {
      releaseWorkflows.push(f);
      continue;
    }
    const name = topLevelWorkflowName(content);
    if (name && RELEASE_FILENAME_PATTERNS.some((p) => p.test(name))) {
      releaseWorkflows.push(f);
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
