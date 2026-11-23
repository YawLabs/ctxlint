import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isDirectory,
  isOutsideRelative,
  loadPackageJson,
  type PackageJson,
} from '../../utils/fs.js';
import { jaccardSimilarityFromSets, toLineSet } from '../../utils/similarity.js';
import { countTokens } from '../../utils/tokens.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

// Map of package names to technology mentions that would be redundant. The
// mention patterns are case-insensitive, so list each spelling once -- a case
// variant ('react' beside 'React') would only match the same text twice.
// Several spellings of one package are alternatives: when more than one
// matches a line, the longest wins ("Vue.js" over "Vue").
const PACKAGE_TECH_MAP: Record<string, string[]> = {
  react: ['React'],
  'react-dom': ['React DOM', 'ReactDOM'],
  next: ['Next.js', 'NextJS'],
  express: ['Express', 'Express.js'],
  fastify: ['Fastify'],
  typescript: ['TypeScript'],
  vue: ['Vue', 'Vue.js'],
  angular: ['Angular'],
  svelte: ['Svelte', 'SvelteKit'],
  tailwindcss: ['Tailwind', 'TailwindCSS'],
  prisma: ['Prisma'],
  drizzle: ['Drizzle'],
  'drizzle-orm': ['Drizzle'],
  jest: ['Jest'],
  vitest: ['Vitest'],
  mocha: ['Mocha'],
  eslint: ['ESLint'],
  prettier: ['Prettier'],
  webpack: ['Webpack'],
  vite: ['Vite'],
  esbuild: ['esbuild'],
  tsup: ['tsup'],
  rollup: ['Rollup'],
  graphql: ['GraphQL'],
  mongoose: ['Mongoose'],
  sequelize: ['Sequelize'],
  'socket.io': ['Socket.IO'],
  redis: ['Redis'],
  ioredis: ['Redis'],
  postgres: ['PostgreSQL', 'Postgres'],
  pg: ['PostgreSQL', 'Postgres'],
  mysql2: ['MySQL'],
  sqlite3: ['SQLite'],
  'better-sqlite3': ['SQLite'],
  zod: ['Zod'],
  joi: ['Joi'],
  axios: ['Axios'],
  lodash: ['Lodash'],
  underscore: ['Underscore'],
  moment: ['Moment', 'moment.js'],
  dayjs: ['Day.js', 'dayjs'],
  'date-fns': ['date-fns'],
  docker: ['Docker'],
  kubernetes: ['Kubernetes', 'K8s'],
  terraform: ['Terraform'],
  storybook: ['Storybook'],
  playwright: ['Playwright'],
  cypress: ['Cypress'],
  puppeteer: ['Puppeteer'],
};

interface CompiledMentionPattern {
  pkg: string;
  mention: string;
  pattern: RegExp;
}

function compilePatterns(relevantPkgs: string[]): CompiledMentionPattern[] {
  const compiled: CompiledMentionPattern[] = [];

  for (const pkg of relevantPkgs) {
    for (const mention of PACKAGE_TECH_MAP[pkg]) {
      const escaped = escapeRegex(mention);
      // One alternation per mention. A bare imperative "use X" is not here on
      // purpose: "Use React Testing Library" / "Use Jest mocks sparingly" are
      // directives about HOW to use a tool, not a description of the stack
      // (see DIRECTIVE_LINE). "we use X" / "the app uses X" are descriptions.
      compiled.push({
        pkg,
        mention,
        pattern: new RegExp(
          `\\b(?:we\\s+use|uses|using|built\\s+with|powered\\s+by|written\\s+in|this\\s+is\\s+an?)\\s+${escaped}\\b|\\b${escaped}\\s+(?:project|app|application|codebase)\\b`,
          'i',
        ),
      });
    }
  }

  return compiled;
}

// A line that tells the agent what to do with a tool ("Use Jest mocks
// sparingly", "Prefer Vitest", "- Never use Lodash") carries a choice, not a
// description of the stack -- the same phrasing contradictions.ts treats as a
// directive. Such a line is never an inferable tech mention, even when it
// names a dependency.
const DIRECTIVE_LINE =
  /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?(?:always\s+|never\s+|only\s+)?(?:use|prefer|avoid|don't|do\s+not|never|always|stick\s+(?:to|with)|default\s+to|choose|pick)\b/i;

// Memo of compiled patterns keyed by the set of RELEVANT deps (those that
// appear in PACKAGE_TECH_MAP) -- compilation depends on nothing else, so two
// projects with the same relevant deps share an entry, and a package.json
// edit in a long-running context (watch mode, MCP server) changes the key.
// Bounded: in a long-running server every distinct dep set would otherwise be
// kept forever. `Map` is insertion-ordered, so a hit is promoted with
// delete+set and the oldest entry evicts when over the cap.
const COMPILED_PATTERNS_MAX_ENTRIES = 64;
const compiledPatternsCache = new Map<string, CompiledMentionPattern[]>();

export function _resetRedundancyCachesForTesting(): void {
  compiledPatternsCache.clear();
}

function getCompiledPatterns(allDeps: Set<string>): CompiledMentionPattern[] {
  const relevant = Object.keys(PACKAGE_TECH_MAP)
    .filter((pkg) => allDeps.has(pkg))
    .sort();
  const key = relevant.join(' ');
  let compiled = compiledPatternsCache.get(key);
  if (compiled) {
    compiledPatternsCache.delete(key);
  } else {
    compiled = compilePatterns(relevant);
  }
  compiledPatternsCache.set(key, compiled);
  if (compiledPatternsCache.size > COMPILED_PATTERNS_MAX_ENTRIES) {
    const oldest = compiledPatternsCache.keys().next().value;
    if (oldest !== undefined) compiledPatternsCache.delete(oldest);
  }
  return compiled;
}

function depSection(pkgJson: PackageJson, pkg: string): string {
  if (pkgJson.dependencies?.[pkg]) return 'dependencies';
  if (pkgJson.devDependencies?.[pkg]) return 'devDependencies';
  if (pkgJson.peerDependencies?.[pkg]) return 'peerDependencies';
  return 'optionalDependencies';
}

interface TechHit {
  pkg: string;
  mention: string;
  index: number;
}

/**
 * The distinct techs a line mentions inferably, in line order. One hit per
 * package (its longest matching spelling), and one per spelling across
 * packages (redis + ioredis both say "Redis").
 */
function techHits(line: string, compiled: CompiledMentionPattern[]): TechHit[] {
  const byPkg = new Map<string, TechHit>();
  for (const { pkg, mention, pattern } of compiled) {
    const m = pattern.exec(line);
    if (!m) continue;
    const prev = byPkg.get(pkg);
    if (!prev || mention.length > prev.mention.length) {
      byPkg.set(pkg, { pkg, mention, index: prev ? Math.min(prev.index, m.index) : m.index });
    }
  }
  const seen = new Set<string>();
  const hits: TechHit[] = [];
  for (const hit of [...byPkg.values()].sort((a, b) => a.index - b.index)) {
    const key = hit.mention.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(hit);
  }
  return hits;
}

function joinList(items: string[]): string {
  return items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export async function checkRedundancy(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // Check 1: Technology mentions that are inferable from package.json. At most
  // one issue per line, listing every tech it names, so the line's tokens are
  // counted once in wastedTokens (audit sums them into estimatedWaste).
  const pkgJson = loadPackageJson(projectRoot);
  if (pkgJson) {
    const allDeps = new Set([
      ...Object.keys(pkgJson.dependencies || {}),
      ...Object.keys(pkgJson.devDependencies || {}),
      ...Object.keys(pkgJson.peerDependencies || {}),
      ...Object.keys(pkgJson.optionalDependencies || {}),
    ]);

    const compiledPatterns = getCompiledPatterns(allDeps);
    const lines = file.content.split('\n');

    if (compiledPatterns.length > 0) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (DIRECTIVE_LINE.test(line)) continue;
        const hits = techHits(line, compiledPatterns);
        if (hits.length === 0) continue;

        const wastedTokens = countTokens(line.trim());
        const message =
          hits.length === 1
            ? `"${hits[0].mention}" is in package.json ${depSection(pkgJson, hits[0].pkg)} — agent can infer this`
            : `${joinList(hits.map((h) => `"${h.mention}" (${depSection(pkgJson, h.pkg)})`))} are in package.json — agent can infer these`;
        issues.push({
          severity: 'info',
          check: 'redundancy',
          ruleId: 'redundancy/tech-mention',
          line: i + 1,
          message,
          suggestion: `~${wastedTokens} tokens could be saved`,
          wastedTokens,
        });
      }
    }
  }

  // Check 2: Directory structure descriptions that match actual structure
  const lines = file.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match patterns like "Components are in src/components/" or "Tests go in
    // tests/". The leading \b keeps the verb from matching inside another
    // word ("Django in backend/" is not "go in backend/").
    const dirMatch = line.match(
      /\b(?:are|go|live|found|located|stored)\s+(?:in|at|under)\s+[`"]?(\S+\/)[`"]?/i,
    );
    if (dirMatch) {
      const dir = dirMatch[1].replace(/[`"]/g, '');
      // Mirror paths.ts: resolve ./ and ../ refs relative to the context
      // file's own directory; everything else relative to the project root.
      const baseDir =
        dir.startsWith('./') || dir.startsWith('../') ? path.dirname(file.filePath) : projectRoot;
      const fullPath = path.resolve(baseDir, dir);
      // Only directories inside the project are "discoverable by listing
      // files"; an absolute temp path or a ../sibling-repo is not.
      const insideProject = !isOutsideRelative(path.relative(projectRoot, fullPath));
      if (insideProject && isDirectory(fullPath)) {
        // The directory exists and is obviously named — agent can discover it
        issues.push({
          severity: 'info',
          check: 'redundancy',
          ruleId: 'redundancy/discoverable-dir',
          line: i + 1,
          message: `Directory "${dir}" exists and is discoverable — agent can find this by listing files`,
          suggestion: 'Only keep if there is non-obvious context about this directory',
        });
      }
    }
  }

  return issues;
}

// Threshold of 0.6 Jaccard similarity = "at least 60% of the union of
// non-trivial lines is shared between the two files." Strict enough not to
// trip on files that happen to share boilerplate (a common disclaimer, a
// shared heading structure) and loose enough to catch AGENTS.md / CLAUDE.md
// pairs that were copy-pasted and lightly diverged — the most common reason
// for duplicate context files. Uses `>=` so a pair that lands exactly on the
// line still gets reported.
const DUPLICATE_CONTENT_THRESHOLD = 0.6;
// Exclusive minimum CHARACTER length of a trimmed line for it to count toward
// the overlap (see toLineSet) -- not a token count.
const DUPLICATE_CONTENT_MIN_LINE_CHARS = 10;

/** Where a symlinked context file points, resolved against its own directory. */
function linkTarget(file: ParsedContextFile): string | undefined {
  if (!file.isSymlink || !file.symlinkTarget) return undefined;
  return path.resolve(path.dirname(file.filePath), file.symlinkTarget);
}

function realPath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * True when one file is a symlink to the other -- the recommended
 * `AGENTS.md -> CLAUDE.md` setup, whose "100% overlap" is the point, not a
 * duplicate. Checks the recorded link target first, then real paths (which
 * also see through a chain of links).
 */
function isSymlinkPair(a: ParsedContextFile, b: ParsedContextFile): boolean {
  if (!a.isSymlink && !b.isSymlink) return false;
  if (linkTarget(a) === path.resolve(b.filePath)) return true;
  if (linkTarget(b) === path.resolve(a.filePath)) return true;
  const realA = realPath(a.filePath);
  return realA !== undefined && realA === realPath(b.filePath);
}

export function checkDuplicateContent(files: ParsedContextFile[]): LintIssue[] {
  const issues: LintIssue[] = [];

  // Precompute the non-trivial-line set once per file. The previous code
  // went through `jaccardSimilarity(contentA, contentB)` per pair, which
  // built two Sets each call; with N files that's 2 * N*(N-1)/2 = N*(N-1)
  // Set builds. Pre-building gets us back to N.
  const lineSets = files.map((f) => toLineSet(f.content, DUPLICATE_CONTENT_MIN_LINE_CHARS));

  for (let i = 0; i < files.length; i++) {
    const a = lineSets[i];
    if (a.size === 0) continue;
    for (let j = i + 1; j < files.length; j++) {
      const b = lineSets[j];
      if (b.size === 0) continue;
      if (isSymlinkPair(files[i], files[j])) continue;
      const overlap = jaccardSimilarityFromSets(a, b);
      if (overlap >= DUPLICATE_CONTENT_THRESHOLD) {
        issues.push({
          severity: 'warning',
          check: 'redundancy',
          ruleId: 'redundancy/duplicate-content',
          line: 1,
          message: `${files[i].relativePath} and ${files[j].relativePath} have ${Math.round(overlap * 100)}% content overlap`,
          suggestion: 'Consider consolidating into a single context file',
        });
      }
    }
  }

  return issues;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
