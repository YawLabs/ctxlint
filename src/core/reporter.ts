import chalk from 'chalk';
import {
  SESSION_AUDIT_PATH_MARKER,
  SKILL_AUDIT_PATH_MARKER,
  type FileResult,
  type LintResult,
  type LintIssue,
} from './types.js';
import { redactSecrets, redactSecretValue } from './checks/content-secrets.js';

type FileGroup = 'context' | 'mcp' | 'session' | 'skill';

/**
 * Classify a result row into one of the four output families. Issue-prefix is
 * the strongest signal because audit.ts dispatches checks per-domain (one
 * file's issues are always from a single family). Path is a fallback for
 * empty-issue rows surfaced in --verbose mode.
 */
function classifyFile(f: FileResult): FileGroup {
  // Synthetic cross-file buckets (audit.ts emits these with these exact paths).
  // Match explicitly so a future synthetic bucket can't silently fall through
  // to the context group.
  if (f.path === '(project)') return 'context';
  if (f.path === '(mcp)') return 'mcp';
  if (f.path.includes(SESSION_AUDIT_PATH_MARKER)) return 'session';
  if (f.path.includes(SKILL_AUDIT_PATH_MARKER)) return 'skill';

  for (const issue of f.issues) {
    if (issue.check.startsWith('session-')) return 'session';
    if (issue.check.startsWith('skill-')) return 'skill';
    if (issue.check.startsWith('mcp-')) return 'mcp';
  }

  // Empty-issue fallback: classify by path so --verbose still groups correctly.
  const norm = f.path.replace(/\\/g, '/');
  if (
    norm === '.mcp.json' ||
    norm.endsWith('/.mcp.json') ||
    norm.endsWith('/mcp.json') ||
    // Windsurf's global config (~/.codeium/windsurf/mcp_config.json,
    // surfaced by scanGlobalMcpConfigs) doesn't match the '/mcp.json' suffix.
    norm.endsWith('/mcp_config.json') ||
    norm.includes('/mcpServers/') ||
    norm.endsWith('/.claude.json') ||
    norm.endsWith('.claude/settings.json') ||
    norm.endsWith('claude_desktop_config.json')
  ) {
    return 'mcp';
  }

  return 'context';
}

const GROUP_ORDER: FileGroup[] = ['context', 'mcp', 'session', 'skill'];
const GROUP_LABELS: Record<FileGroup, string> = {
  context: 'Context Files',
  mcp: 'MCP Configs',
  session: 'Session Audit',
  skill: 'Skill Audit',
};
const GROUP_SUMMARY_NOUNS: Record<FileGroup, string> = {
  context: 'context file',
  mcp: 'MCP config',
  session: 'session audit',
  skill: 'skill audit',
};

function isSyntheticBucket(p: string): boolean {
  // Exact-match the cross-file bucket labels (mirroring classifyFile's
  // equality checks) rather than a '(' prefix test: a real context file under
  // a paren-named directory (e.g. a Next.js route group like
  // '(docs)/CLAUDE.md') must not be silently dropped from the summaries.
  return (
    p === '(project)' ||
    p === '(mcp)' ||
    p.includes(SESSION_AUDIT_PATH_MARKER) ||
    p.includes(SKILL_AUDIT_PATH_MARKER)
  );
}

/**
 * A project settings file that carries hook-coverage findings (audit.ts files
 * them under the settings file's own path). It is not a context file: it is
 * left out of the "Found N context files" summary and the token table.
 */
function isSettingsFile(p: string): boolean {
  return /(^|\/)\.claude\/settings(\.local)?\.json$/.test(p.replace(/\\/g, '/'));
}

/** Real context files: the context group minus synthetic buckets and settings files. */
function contextFiles(files: FileResult[]): FileResult[] {
  return files.filter(
    (f) => classifyFile(f) === 'context' && !isSyntheticBucket(f.path) && !isSettingsFile(f.path),
  );
}

export function formatText(raw: LintResult, verbose: boolean = false): string {
  const result = redactResultForOutput(raw);
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold(`ctxlint v${result.version}`));
  // Detected by runAudit (detectVersionSkew); the formatter only renders it.
  const skew = raw.versionSkew;
  if (skew) {
    lines.push(
      chalk.yellow(
        `  note: this checkout is v${skew.checkoutVersion} -- you are running v${skew.runningVersion}. ` +
          'Rebuild or reinstall before trusting a result against it.',
      ),
    );
  }
  lines.push('');
  lines.push(`Scanning ${result.projectRoot}...`);
  lines.push('');

  // Bucket every result row by family.
  const groups: Record<FileGroup, FileResult[]> = {
    context: [],
    mcp: [],
    session: [],
    skill: [],
  };
  for (const f of result.files) {
    groups[classifyFile(f)].push(f);
  }

  // Top summary: show file lists per non-empty group, hiding the synthetic
  // cross-file buckets ('(project)', '(mcp)', '~/.claude/ (session audit)').
  // Those aren't files the user authored — they appear in the issue listing
  // section below.
  let renderedAnySummary = false;

  const contextReal = contextFiles(result.files);
  // summary.totalTokens is the one definition every format prints: context
  // files only (MCP configs are not loaded into agent context), a symlinked
  // alias of another counted file once. See audit.ts contextTokenTotal.
  const contextTokens = result.summary.totalTokens;
  if (contextReal.length > 0) {
    lines.push(
      `Found ${contextReal.length} context file${contextReal.length !== 1 ? 's' : ''} (${contextTokens.toLocaleString()} tokens total)`,
    );
    for (const file of contextReal) {
      let desc = `  ${file.path} (${file.tokens.toLocaleString()} tokens, ${file.lines} lines)`;
      if (file.isSymlink && file.symlinkTarget) {
        desc = `  ${file.path} ${chalk.dim(`-> ${file.symlinkTarget} (symlink)`)}`;
      }
      lines.push(desc);
    }
    renderedAnySummary = true;
  }

  {
    const real = groups.mcp.filter((f) => !isSyntheticBucket(f.path));
    if (real.length > 0) {
      if (renderedAnySummary) lines.push('');
      lines.push(`Found ${real.length} ${GROUP_SUMMARY_NOUNS.mcp}${real.length !== 1 ? 's' : ''}`);
      for (const file of real) lines.push(`  ${file.path}`);
      renderedAnySummary = true;
    }
  }

  // Session has no real files, only the synthetic audit bucket. Show it as a
  // header (when present) so users see "session was scanned" before the
  // detailed findings.
  if (groups.session.length > 0) {
    if (renderedAnySummary) lines.push('');
    lines.push('Session audit scanned');
    renderedAnySummary = true;
  }

  // Skill audit, like session, has no real authored files -- it's a synthetic
  // bucket (SKILL_AUDIT_LABEL from audit.ts, path starting with '~', filtered
  // out of the real-file summaries above). Without this arm a clean
  // --skills-only run rendered no group summary and fell through to the
  // misleading "Found N files" line.
  if (groups.skill.length > 0) {
    if (renderedAnySummary) lines.push('');
    lines.push('Skill audit scanned');
    renderedAnySummary = true;
  }

  if (!renderedAnySummary) {
    lines.push(`Found ${result.files.length} file${result.files.length !== 1 ? 's' : ''}`);
  }

  lines.push('');

  // Per-file issues — grouped by family.
  const renderFileGroup = (files: FileResult[]) => {
    for (const file of files) {
      const fileIssues = file.issues;
      if (fileIssues.length === 0 && !verbose) continue;

      lines.push(chalk.underline(file.path));

      if (fileIssues.length === 0) {
        lines.push(chalk.green('  [ok] All checks passed'));
      } else {
        for (const issue of fileIssues) {
          lines.push(formatIssue(issue));
        }
      }

      lines.push('');
    }
  };

  // Show bold group headers whenever 2+ groups have content to render.
  const groupsToRender = GROUP_ORDER.filter((g) =>
    groups[g].some((f) => f.issues.length > 0 || verbose),
  );

  if (groupsToRender.length > 1) {
    for (const g of groupsToRender) {
      lines.push(chalk.bold(GROUP_LABELS[g]));
      renderFileGroup(groups[g]);
    }
  } else {
    renderFileGroup(result.files);
  }

  // Summary
  const { errors, warnings, info } = result.summary;
  const parts: string[] = [];
  if (errors > 0) parts.push(chalk.red(`${errors} error${errors !== 1 ? 's' : ''}`));
  if (warnings > 0) parts.push(chalk.yellow(`${warnings} warning${warnings !== 1 ? 's' : ''}`));
  if (info > 0) parts.push(chalk.blue(`${info} info`));

  if (parts.length > 0) {
    lines.push(`Summary: ${parts.join(', ')}`);
  } else {
    lines.push(chalk.green('No issues found!'));
  }

  lines.push(`  Token usage: ${contextTokens.toLocaleString()} tokens per agent session`);

  if (result.summary.estimatedWaste > 0) {
    lines.push(`  Estimated waste: ~${result.summary.estimatedWaste} tokens (redundant content)`);
  }

  // Ignore-rule drift footer. Surfaces dropped count + unused rules + rules
  // missing a `reason` so maintainers can review their `.ctxlintrc.json`
  // ignoreRules entries periodically. Mirrors the JSON `_meta.ignoreReport`
  // block and the MCP response payload.
  const ig = result._meta?.ignoreReport;
  if (ig && (ig.dropped > 0 || ig.unusedRules.length > 0 || ig.rulesMissingReason.length > 0)) {
    lines.push('');
    lines.push(chalk.bold('Ignore rules'));
    if (ig.dropped > 0) {
      lines.push(
        chalk.dim(`  ${ig.dropped} finding${ig.dropped !== 1 ? 's' : ''} dropped by ignoreRules`),
      );
    }
    if (ig.unusedRules.length > 0) {
      lines.push(
        chalk.yellow(
          `  ${ig.unusedRules.length} ignore rule${ig.unusedRules.length !== 1 ? 's' : ''} never fired (drift -- consider removing):`,
        ),
      );
      for (const r of ig.unusedRules) {
        lines.push(`    - ${formatIgnoreRule(r)}`);
      }
    }
    if (ig.rulesMissingReason.length > 0) {
      lines.push(
        chalk.yellow(
          `  ${ig.rulesMissingReason.length} ignore rule${ig.rulesMissingReason.length !== 1 ? 's' : ''} missing a "reason" field:`,
        ),
      );
      for (const r of ig.rulesMissingReason) {
        lines.push(`    - ${formatIgnoreRule(r)}`);
      }
    }
  }

  lines.push('');

  return lines.join('\n');
}

function formatIgnoreRule(r: {
  check: string;
  match?: string;
  pathPattern?: string;
  reason?: string;
}): string {
  const parts: string[] = [r.check];
  if (r.match) parts.push(`match=/${r.match}/`);
  if (r.pathPattern) parts.push(`pathPattern=/${r.pathPattern}/`);
  if (r.reason) parts.push(`reason="${r.reason}"`);
  return parts.join(' ');
}

/**
 * Checks whose fixes replace a secret value. Their `fix.oldText` is the secret
 * itself even when no known-format pattern matches it (mcp-security's
 * high-entropy heuristic), so it is redacted unconditionally.
 */
const SECRET_FIX_CHECKS: ReadonlySet<string> = new Set(['mcp-security', 'content-secrets']);

// An env-var reference in any client syntax: ${{ secrets.VAR }}, ${env:VAR},
// ${VAR}. These spans are never a literal secret and are left readable.
const ENV_REF_SPAN = /\$\{\{[^}]*\}\}|\$\{[^}]*\}/g;

// `scheme://user:password@` -- group 2 is the password.
const URL_USERINFO_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^\s/?#:@]*:)([^\s/?#@]*)@/gi;

// A secret-named URL query param; group 2 is its value. Same names as
// mcp-security's URL_SECRET_PARAMS.
const URL_SECRET_PARAM =
  /([?&](?:key|token|api_key|apikey|secret|password|access_token)=)([^&#\s"']*)/gi;

// A long run of key-alphabet characters mixing upper case, lower case and
// digits: the shape of a random API key. '/' is left out of the class so a
// filesystem path or URL path never forms one run.
const KEY_SHAPED_RUN = /[A-Za-z0-9+=_-]{21,}/g;

function hasLiteral(value: string): boolean {
  return value.replace(ENV_REF_SPAN, '').length > 0;
}

function isKeyShaped(run: string): boolean {
  return /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run);
}

/**
 * Mask a credential that sits as a literal inside a non-secret fix's text:
 * a URL userinfo password, the value of a secret-named URL query param, and
 * any key-shaped run outside an env-var ref. A fix whose text spans a whole
 * value (`...?api_key=<literal>&ws=${WS}`) carries such literals -- mcp-env's
 * syntax fixes did before they narrowed to the ref alone -- and none of them
 * need match a known-token pattern for redactSecrets to catch them. Env-var refs are never touched, so the part a syntax fix
 * changes stays readable.
 */
export function redactLiteralCredentials(text: string): string {
  let out = text.replace(URL_USERINFO_PASSWORD, (m, head: string, pw: string) =>
    hasLiteral(pw) ? `${head}${redactSecretValue(pw)}@` : m,
  );
  out = out.replace(URL_SECRET_PARAM, (m, head: string, value: string) =>
    hasLiteral(value) ? `${head}${redactSecretValue(value)}` : m,
  );
  // Key-shaped runs: scan only the literal segments between env refs.
  let result = '';
  let last = 0;
  const maskSegment = (segment: string) =>
    segment.replace(KEY_SHAPED_RUN, (run) => (isKeyShaped(run) ? redactSecretValue(run) : run));
  for (const ref of out.matchAll(ENV_REF_SPAN)) {
    result += maskSegment(out.slice(last, ref.index)) + ref[0];
    last = ref.index + ref[0].length;
  }
  return result + maskSegment(out.slice(last));
}

function redactIssueForOutput(issue: LintIssue): LintIssue {
  const out: LintIssue = { ...issue, message: redactSecrets(issue.message) };
  if (issue.suggestion !== undefined) out.suggestion = redactSecrets(issue.suggestion);
  if (issue.detail !== undefined) out.detail = redactSecrets(issue.detail);
  if (issue.fix) {
    out.fix = {
      ...issue.fix,
      oldText: SECRET_FIX_CHECKS.has(issue.check)
        ? redactSecretValue(issue.fix.oldText)
        : redactLiteralCredentials(redactSecrets(issue.fix.oldText)),
      newText: redactLiteralCredentials(redactSecrets(issue.fix.newText)),
    };
  }
  return out;
}

/**
 * A copy of `result` safe to print or hand to another process: secrets are
 * redacted from every issue's text and fix values. The audit already redacts
 * the text fields (repeating it here is idempotent and covers results built
 * elsewhere); fix values are only redacted here because the fixer needs the
 * real oldText, so `result` itself is never modified.
 */
export function redactResultForOutput<T extends LintResult>(result: T): T {
  return {
    ...result,
    files: result.files.map((f) => ({ ...f, issues: f.issues.map(redactIssueForOutput) })),
  };
}

export function formatJson(result: LintResult): string {
  return JSON.stringify(redactResultForOutput(result), null, 2);
}

export function formatTokenReport(result: LintResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(chalk.bold('Token Usage Report'));
  lines.push(
    chalk.dim('  (counts use GPT-4 cl100k_base tokenizer — Claude counts may vary slightly)'),
  );
  lines.push('');

  // Context files only, the same set formatText summarizes: synthetic buckets
  // ((project), (mcp), ~/.claude/ (session audit)) carry 0 tokens and would
  // only widen maxPathLen, and MCP configs are not loaded as context, so they
  // are not part of the Total (summary.totalTokens) either.
  const realFiles = contextFiles(result.files);

  const maxPathLen = Math.max(...realFiles.map((f) => f.path.length), 4);

  lines.push(
    `  ${chalk.dim('File'.padEnd(maxPathLen))}  ${chalk.dim('Tokens'.padStart(8))}  ${chalk.dim('Lines'.padStart(6))}`,
  );
  lines.push(`  ${'-'.repeat(maxPathLen)}  ${'-'.repeat(8)}  ${'-'.repeat(6)}`);

  for (const file of realFiles) {
    const tokenStr = file.tokens.toLocaleString().padStart(8);
    const lineStr = file.lines.toString().padStart(6);
    // A symlinked alias of another counted file is not added to the Total.
    const alias =
      file.isSymlink && file.symlinkTarget ? chalk.dim(`  -> ${file.symlinkTarget} (symlink)`) : '';
    lines.push(`  ${file.path.padEnd(maxPathLen)}  ${tokenStr}  ${lineStr}${alias}`);
  }

  lines.push(`  ${'-'.repeat(maxPathLen)}  ${'-'.repeat(8)}  ${'-'.repeat(6)}`);
  lines.push(
    `  ${'Total'.padEnd(maxPathLen)}  ${result.summary.totalTokens.toLocaleString().padStart(8)}`,
  );

  if (result.summary.estimatedWaste > 0) {
    lines.push('');
    lines.push(
      chalk.yellow(
        `  ~${result.summary.estimatedWaste} tokens estimated waste from redundant content`,
      ),
    );
  }

  lines.push('');

  return lines.join('\n');
}

/**
 * Audit collects cross-file and session-scope findings into synthetic
 * file-result buckets keyed by labels like `(project)`, `(mcp)`, and
 * `~/.claude/ (session audit)` (see audit.ts). Those labels aren't real
 * relative paths and must not flow through to SARIF's
 * `physicalLocation.artifactLocation.uri`, which GitHub Code Scanning
 * interprets as a repo-relative file path. For those buckets the label goes
 * in `logicalLocations`, and the physicalLocation is a real anchor file
 * (see anchorFor) rather than the label.
 */
function isSyntheticPath(p: string): boolean {
  // Share the central predicate (exact '(project)' / '(mcp)' labels +
  // session/skill markers) so a reskinned label that carries a marker but
  // does NOT start with '~' (e.g. '$HOME/.claude/ (session audit)') can't
  // leak into a SARIF physicalLocation.artifactLocation.uri. The extra '~'
  // prefix here covers any future '~'-rooted bucket label that doesn't match
  // a known marker. Real paths under paren-named dirs (e.g. a Next.js route
  // group like '(docs)/CLAUDE.md') intentionally fail the predicate and get
  // a normal physicalLocation.
  return isSyntheticBucket(p) || p.startsWith('~');
}

/**
 * A repo-relative path as a SARIF `artifactLocation.uri`: forward slashes, each
 * segment percent-encoded (RFC 3986), so a space or `#` in a file name can't
 * produce an invalid or mis-split URI reference.
 */
export function toSarifUri(p: string): string {
  return p.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
}

/** A path that can be a physicalLocation: real, project-relative, inside the root. */
function isPhysicalPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  return (
    !isSyntheticPath(p) &&
    !norm.startsWith('/') &&
    !/^[A-Za-z]:/.test(norm) &&
    norm !== '..' &&
    !norm.startsWith('../')
  );
}

/**
 * The real file a synthetic bucket's findings are pinned to. GitHub code
 * scanning requires a physicalLocation on every result (a result with only
 * logicalLocations is not displayed), so a cross-file finding is anchored on
 * the most relevant file of the same family: the shallowest context file for
 * `(project)` (the root CLAUDE.md / AGENTS.md when there is one), the first
 * project MCP config for `(mcp)`. Session and skill findings have no file in
 * the repo; they fall back to the shallowest real file of any family. Null
 * when the run has no real file at all (e.g. --session-only); those results
 * keep logicalLocations only.
 */
function anchorFor(bucket: FileResult, files: FileResult[]): string | null {
  const real = files.filter((f) => isPhysicalPath(f.path));
  const depth = (p: string) => p.replace(/\\/g, '/').split('/').length;
  const shallowest = (list: FileResult[]) =>
    list.reduce<FileResult | null>(
      (best, f) => (!best || depth(f.path) < depth(best.path) ? f : best),
      null,
    )?.path ?? null;
  const group = classifyFile(bucket);
  const sameFamily = real.filter(
    (f) => classifyFile(f) === group && !(group === 'context' && isSettingsFile(f.path)),
  );
  const pick = group === 'mcp' ? (sameFamily[0]?.path ?? null) : shallowest(sameFamily);
  return pick ?? shallowest(real);
}

/** The SARIF ruleId of an issue: the specific rule when it has one, else its check family. */
function sarifRuleId(issue: LintIssue): string {
  return `ctxlint/${issue.ruleId ?? issue.check}`;
}

/**
 * Formats results as SARIF v2.1.0 for GitHub Code Scanning and other SARIF consumers.
 * https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */
export function formatSarif(raw: LintResult): string {
  const result = redactResultForOutput(raw);
  const severityToLevel: Record<string, string> = {
    error: 'error',
    warning: 'warning',
    info: 'note',
  };

  const results: SarifResult[] = [];
  const usedRuleIds = new Map<string, LintIssue>();

  for (const file of result.files) {
    const synthetic = !isPhysicalPath(file.path);
    const anchor = synthetic ? anchorFor(file, result.files) : null;
    for (const issue of file.issues) {
      let location: SarifLocation;
      if (!synthetic) {
        location = {
          physicalLocation: {
            artifactLocation: { uri: toSarifUri(file.path), uriBaseId: '%SRCROOT%' },
            region: { startLine: Math.max(issue.line, 1) },
          },
        };
      } else {
        // The bucket label stays as a logical location; the anchor file (if
        // any) supplies the physicalLocation GitHub needs. A bucket finding's
        // line is not a line of the anchor file, so the region is line 1.
        location = { logicalLocations: [{ name: file.path, kind: 'resource' }] };
        if (anchor !== null) {
          location.physicalLocation = {
            artifactLocation: { uri: toSarifUri(anchor), uriBaseId: '%SRCROOT%' },
            region: { startLine: 1 },
          };
        }
      }

      const ruleId = sarifRuleId(issue);
      if (!usedRuleIds.has(ruleId)) usedRuleIds.set(ruleId, issue);
      const sarifResult: SarifResult = {
        ruleId,
        level: severityToLevel[issue.severity] || 'note',
        message: {
          text: issue.message + (issue.suggestion ? ` (${issue.suggestion})` : ''),
        },
        locations: [location],
      };

      if (issue.detail) {
        sarifResult.message.text += `\n${issue.detail}`;
      }

      results.push(sarifResult);
    }
  }

  // One descriptor per check family, plus one per specific ruleId the results
  // use, so every result's ruleId resolves to a reportingDescriptor. A
  // specific rule inherits its family's description and help link.
  const families = buildRuleDescriptors();
  const byId = new Map(families.map((r) => [r.id, r]));
  const rules = [...families];
  for (const [id, issue] of usedRuleIds) {
    if (byId.has(id)) continue;
    const family = byId.get(`ctxlint/${issue.check}`);
    const rule: SarifRule = {
      id,
      shortDescription: family?.shortDescription ?? { text: issue.check },
      helpUri: family?.helpUri ?? 'https://github.com/yawlabs/ctxlint#what-it-checks',
    };
    byId.set(id, rule);
    rules.push(rule);
  }

  const sarif: SarifLog = {
    version: '2.1.0',
    $schema:
      'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    runs: [
      {
        tool: {
          driver: {
            name: 'ctxlint',
            version: result.version,
            informationUri: 'https://github.com/yawlabs/ctxlint',
            rules,
          },
        },
        results,
      },
    ],
  };

  return JSON.stringify(sarif, null, 2);
}

function buildRuleDescriptors(): SarifRule[] {
  return [
    {
      id: 'ctxlint/paths',
      shortDescription: { text: 'File path does not exist in project' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/commands',
      shortDescription: { text: 'Command does not match project scripts' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/staleness',
      shortDescription: { text: 'Context file is stale relative to referenced code' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/tokens',
      shortDescription: { text: 'Context file token usage' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/tier-tokens',
      shortDescription: {
        text: 'Tier-aware token accounting for always-loaded context files',
      },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/redundancy',
      shortDescription: { text: 'Content is redundant or inferable' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/contradictions',
      shortDescription: { text: 'Conflicting directives across context files' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/frontmatter',
      shortDescription: { text: 'Invalid or missing frontmatter' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/ci-coverage',
      shortDescription: { text: 'CI release workflow not documented in context files' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/ci-secrets',
      shortDescription: { text: 'CI secret not documented in context files' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/content-secrets',
      shortDescription: { text: 'Inline-pasted secret detected in a context file' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/hook-coverage',
      shortDescription: { text: 'Hook/permission entry references a script that no longer exists' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/mcp-schema',
      shortDescription: { text: 'MCP config structural validation error' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-security',
      shortDescription: { text: 'Hardcoded secret in MCP config' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-commands',
      shortDescription: { text: 'MCP stdio command validation issue' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-deprecated',
      shortDescription: { text: 'Deprecated MCP transport or pattern' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-env',
      shortDescription: { text: 'MCP environment variable syntax issue' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-urls',
      shortDescription: { text: 'MCP URL validation issue' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-consistency',
      shortDescription: { text: 'MCP config inconsistency across clients' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/mcp-redundancy',
      shortDescription: { text: 'Redundant MCP config entry' },
      helpUri: 'https://github.com/yawlabs/ctxlint#mcp-config-linting',
    },
    {
      id: 'ctxlint/session-missing-secret',
      shortDescription: { text: 'GitHub secret set on sibling repos but missing here' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-diverged-file',
      shortDescription: { text: 'Canonical file has diverged from sibling repos' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-missing-workflow',
      shortDescription: { text: 'GitHub Actions workflow present in siblings but missing here' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-stale-memory',
      shortDescription: { text: 'Memory file references paths that no longer exist' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-duplicate-memory',
      shortDescription: { text: 'Near-duplicate memory entries across projects' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-loop-detection',
      shortDescription: { text: 'Agent looping pattern detected in session history' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-memory-index-overflow',
      shortDescription: {
        text: "MEMORY.md exceeds Claude Code's 200-line / 25KB session-load cap",
      },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-shared-temp-path',
      shortDescription: {
        text: 'Fixed temp path written then read back -- clobberable by a concurrent session',
      },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-unverified-gate-claimed-clean',
      shortDescription: {
        text: 'A quality gate asserted as passing while its invocation failed or emitted nothing',
      },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-default-branch-accumulation',
      shortDescription: {
        text: 'Many files edited on the default branch with no intervening commit',
      },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-unresolvable-sha',
      shortDescription: {
        text: 'Memory cites a git SHA that no longer resolves in the repository',
      },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/session-large-read',
      shortDescription: {
        text: 'Whole-file Reads of large files re-sent as context on every later turn',
      },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/skill-frontmatter',
      shortDescription: { text: 'Skill/agent definition missing required frontmatter' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/skill-broken-ref',
      shortDescription: { text: 'Skill/agent body references a path that does not exist' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/skill-trigger-collision',
      shortDescription: { text: 'Two skills/agents declare the same trigger phrase' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/skill-orphaned',
      shortDescription: { text: 'Skill directory has no SKILL.md' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
    {
      id: 'ctxlint/skill-dead-tool-restriction',
      shortDescription: { text: 'Agent tool restriction names an unknown Claude Code tool' },
      helpUri: 'https://github.com/yawlabs/ctxlint#what-it-checks',
    },
  ];
}

// SARIF type definitions (minimal, for output only)
interface SarifLog {
  version: string;
  $schema: string;
  runs: SarifRun[];
}

interface SarifRun {
  tool: { driver: SarifDriver };
  results: SarifResult[];
}

interface SarifDriver {
  name: string;
  version: string;
  informationUri: string;
  rules: SarifRule[];
}

interface SarifRule {
  id: string;
  shortDescription: { text: string };
  helpUri: string;
}

interface SarifResult {
  ruleId: string;
  level: string;
  message: { text: string };
  locations: SarifLocation[];
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation: { uri: string; uriBaseId: string };
    region: { startLine: number };
  };
  logicalLocations?: SarifLogicalLocation[];
}

interface SarifLogicalLocation {
  name: string;
  kind?: string;
}

function formatIssue(issue: LintIssue): string {
  const icon =
    issue.severity === 'error'
      ? chalk.red('x')
      : issue.severity === 'warning'
        ? chalk.yellow('!')
        : chalk.blue('i');

  const lineRef = issue.line > 0 ? `Line ${issue.line}: ` : '';
  let line = `  ${icon} ${lineRef}${issue.message}`;

  if (issue.suggestion) {
    line += `\n    ${chalk.dim('->')} ${chalk.dim(issue.suggestion)}`;
  }
  if (issue.detail) {
    line += `\n    ${chalk.dim(issue.detail)}`;
  }

  return line;
}
