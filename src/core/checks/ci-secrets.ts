import type { ParsedContextFile, LintIssue } from '../types.js';
import { readWorkflowFiles } from './workflow-files.js';

// Secrets GitHub itself provides that need no documentation. GITHUB_TOKEN is
// the only one reachable through the `secrets` context; the ACTIONS_* names
// (ACTIONS_RUNTIME_TOKEN, ACTIONS_ID_TOKEN_REQUEST_URL, ...) are runner
// environment variables, so a `secrets.ACTIONS_RUNTIME_TOKEN` reference is a
// user-created secret like any other.
// https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication
// Stored uppercase: secret names are case-insensitive (see secretKey).
const BUILTIN_SECRETS = new Set(['GITHUB_TOKEN']);

// Secret references inside an expression: `secrets.NAME` and the index form
// `secrets['NAME']` / `secrets["NAME"]`. Matched anywhere inside the
// expression, so `secrets.A || secrets.B` and `inputs.t || secrets.C` yield
// every name, not just a lone `${{ secrets.X }}`.
const SECRET_REF = /\bsecrets\s*(?:\.\s*([A-Za-z_]\w*)|\[\s*(['"])([^'"\]]+)\2\s*\])/g;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
// `if:` values are expressions even without the `${{ }}` wrapper.
const IF_KEY = /^\s*(?:-\s+)?if:\s*(.+)$/;
// A key whose value is a block scalar (`run: |`, `script: >-`): the indented
// lines below it are string content, where `#` is NOT a YAML comment -- and
// GitHub still expands `${{ }}` there.
const BLOCK_SCALAR_KEY = /^(\s*)(?:-\s+)?[\w.-]+:\s*[|>][+-]?\d*\s*(?:#.*)?$/;

/** GitHub resolves secret names case-insensitively; key them uppercase. */
function secretKey(name: string): string {
  return name.toUpperCase();
}

interface SecretUsage {
  name: string;
  workflows: string[];
}

/**
 * The parts of a workflow that GitHub evaluates for secret references, with
 * YAML comments removed: whole-line `#` comments (outside block scalars) and
 * trailing ` # ...` comments after the last expression on a line.
 */
function expressionSources(content: string): string[] {
  const sources: string[] = [];
  let blockIndent = -1; // indentation of the key that opened a block scalar
  for (const line of content.split('\n')) {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (!line.trim() || indent > blockIndent) {
        for (const m of line.matchAll(EXPRESSION)) sources.push(m[1]);
        continue;
      }
      blockIndent = -1;
    }
    if (line.trimStart().startsWith('#')) continue;
    // Drop a trailing comment: a ` #` after the last `}}` on the line (an
    // expression body can't contain one without being quoted).
    const lastClose = line.lastIndexOf('}}');
    const commentAt = line.slice(lastClose + 1).search(/\s#/);
    const code = commentAt >= 0 ? line.slice(0, lastClose + 1 + commentAt) : line;
    for (const m of code.matchAll(EXPRESSION)) sources.push(m[1]);
    const ifMatch = IF_KEY.exec(code);
    if (ifMatch && !ifMatch[1].includes('${{')) sources.push(ifMatch[1]);
    const block = BLOCK_SCALAR_KEY.exec(code);
    if (block) blockIndent = block[1].length;
  }
  return sources;
}

async function findSecretUsages(projectRoot: string): Promise<SecretUsage[]> {
  // Keyed by secretKey; the value keeps the first spelling seen for display.
  const secretMap = new Map<string, SecretUsage>();

  for (const { name: f, content } of await readWorkflowFiles(projectRoot)) {
    for (const source of expressionSources(content)) {
      for (const m of source.matchAll(SECRET_REF)) {
        const name = m[1] ?? m[3];
        const key = secretKey(name);
        if (BUILTIN_SECRETS.has(key)) continue;
        let usage = secretMap.get(key);
        if (!usage) {
          usage = { name, workflows: [] };
          secretMap.set(key, usage);
        }
        if (!usage.workflows.includes(f)) usage.workflows.push(f);
      }
    }
  }

  return [...secretMap.values()];
}

// Secret names built only from words that double as ordinary English -- the
// single words "TOKEN", "KEY" and the two-word API_KEY, ACCESS_TOKEN,
// AUTH_TOKEN -- would be "documented" by any prose containing those words
// ("never commit an API key"), and those are exactly the secrets whose names
// most need real documentation. For these, only the exact name in the
// conventional uppercase env-var form, a backticked mention of the name in any
// case, or an explicit `secrets.<NAME>` reference counts. Names with a
// distinguishing word (NPM_TOKEN, AWS_ACCESS_KEY) keep the loose
// case-insensitive, separator-flexible match ("the npm token").
const GENERIC_SECRET_WORDS = new Set([
  'TOKEN',
  'KEY',
  'SECRET',
  'PAT',
  'PASSWORD',
  'PASS',
  'APIKEY',
  'API',
  'ACCESS',
  'AUTH',
  'PRIVATE',
  'CLIENT',
  'ID',
]);

function isGenericSecretName(name: string): boolean {
  const upper = name.toUpperCase();
  if (!upper.includes('_')) return upper.length <= 5 || GENERIC_SECRET_WORDS.has(upper);
  return upper
    .split('_')
    .filter(Boolean)
    .every((part) => GENERIC_SECRET_WORDS.has(part));
}

function contextMentionsSecret(files: ParsedContextFile[], secretName: string): boolean {
  // Escape regex-special chars, then allow `_`, space, or hyphen between the
  // tokens of the original name. Notes on the character class:
  //
  //  - We deliberately do NOT include `\s` (which matches newlines and tabs).
  //    Using `\s` causes `NPM_TOKEN` to match the literal sequence
  //    `NPM\nTOKEN` straddling two paragraphs, silently swallowing a real
  //    "undocumented secret" finding when the two halves of the name happen
  //    to land at a paragraph boundary.
  //  - Just a literal space ` ` is the in-prose form ("npm token", "GitHub
  //    token"); `_` is the env-var form; `-` is the kebab form ("npm-token").
  //
  // The class demands exactly one separator, which is what rejects a run-on
  // like `npmtoken`. The `\b` anchors at both ends reject the name embedded in
  // a longer identifier (`MY_NPM_TOKEN`, `NPM_TOKEN_2`), since `_` and digits
  // are word characters.
  const escaped = secretName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (isGenericSecretName(secretName)) {
    // Always demand the conventional uppercase env-var form, regardless of
    // how the workflow spelled the reference: GitHub secret lookups are
    // case-insensitive, so `${{ secrets.token }}` is valid and arrives here
    // lowercase. Building the probe from the as-written name would let
    // ordinary prose ("request a token") count as documentation while a
    // conventional "Set TOKEN" doc mention would not.
    const exactCase = new RegExp(`\\b${escaped.toUpperCase()}\\b`);
    const backticked = new RegExp(`\`[^\`\\n]*\\b${escaped}\\b[^\`\\n]*\``, 'i');
    const secretsRef = new RegExp(`\\bsecrets\\.${escaped}\\b`, 'i');
    return files.some(
      (f) => exactCase.test(f.content) || backticked.test(f.content) || secretsRef.test(f.content),
    );
  }
  const pattern = new RegExp(`\\b${escaped.replace(/_/g, '[ _-]')}\\b`, 'i');
  return files.some((f) => pattern.test(f.content));
}

/**
 * Parse CI workflows for secret references (`secrets.X` / `secrets['X']` in
 * any expression or `if:` condition) and flag any that aren't mentioned in
 * context files. Undocumented secrets cause agents
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
      ruleId: 'ci-secrets/undocumented-secret',
      line: 0,
      message: `CI secret "${name}" is used in ${workflows.join(', ')} but not mentioned in any context file`,
      suggestion: `Document what ${name} is and how to set it (e.g. "gh secret set ${name}") so agents don't create new tokens or guess`,
    });
  }

  return issues;
}
