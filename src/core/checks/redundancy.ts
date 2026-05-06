import * as path from 'node:path';
import { isDirectory, loadPackageJson } from '../../utils/fs.js';
import { jaccardSimilarityFromSets, toLineSet } from '../../utils/similarity.js';
import { countTokens } from '../../utils/tokens.js';
import type { ParsedContextFile, LintIssue } from '../types.js';

// Map of package names to technology mentions that would be redundant
const PACKAGE_TECH_MAP: Record<string, string[]> = {
  react: ['React', 'react'],
  'react-dom': ['React DOM', 'ReactDOM'],
  next: ['Next.js', 'NextJS', 'next.js'],
  express: ['Express', 'express.js'],
  fastify: ['Fastify'],
  typescript: ['TypeScript'],
  vue: ['Vue', 'Vue.js', 'vue.js'],
  angular: ['Angular'],
  svelte: ['Svelte', 'SvelteKit'],
  tailwindcss: ['Tailwind', 'TailwindCSS', 'tailwind'],
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
  'socket.io': ['Socket.IO', 'socket.io'],
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
  lodash: ['Lodash', 'lodash'],
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
  patterns: RegExp[];
}

function compilePatterns(allDeps: Set<string>): CompiledMentionPattern[] {
  const compiled: CompiledMentionPattern[] = [];

  for (const [pkg, mentions] of Object.entries(PACKAGE_TECH_MAP)) {
    if (!allDeps.has(pkg)) continue;

    for (const mention of mentions) {
      const escaped = escapeRegex(mention);
      compiled.push({
        pkg,
        mention,
        patterns: [
          new RegExp(`\\b(?:use|using|built with|powered by|written in)\\s+${escaped}\\b`, 'i'),
          new RegExp(`\\bwe\\s+use\\s+${escaped}\\b`, 'i'),
          new RegExp(`\\b${escaped}\\s+(?:project|app|application|codebase)\\b`, 'i'),
          new RegExp(`\\bThis is a\\s+${escaped}\\b`, 'i'),
        ],
      });
    }
  }

  return compiled;
}

// Cache compiled patterns keyed by (projectRoot, dep-set fingerprint). The
// dep set is stable across the per-file loop in a single audit run, so this
// turns N compiles into 1. Including the fingerprint in the key keeps the
// cache correct in long-running contexts (watch mode, MCP server) where
// package.json can change between audits.
const compiledPatternsCache = new Map<string, CompiledMentionPattern[]>();

export function _resetRedundancyCachesForTesting(): void {
  compiledPatternsCache.clear();
}

function getCompiledPatterns(projectRoot: string, allDeps: Set<string>): CompiledMentionPattern[] {
  // Only deps that actually appear in PACKAGE_TECH_MAP affect compilation, so
  // we fingerprint the intersection rather than every dep in package.json.
  const relevant: string[] = [];
  for (const pkg of Object.keys(PACKAGE_TECH_MAP)) {
    if (allDeps.has(pkg)) relevant.push(pkg);
  }
  relevant.sort();
  const key = `${projectRoot}\0${relevant.join(' ')}`;
  let compiled = compiledPatternsCache.get(key);
  if (!compiled) {
    compiled = compilePatterns(allDeps);
    compiledPatternsCache.set(key, compiled);
  }
  return compiled;
}

export async function checkRedundancy(
  file: ParsedContextFile,
  projectRoot: string,
): Promise<LintIssue[]> {
  const issues: LintIssue[] = [];

  // Check 1: Technology mentions that are inferable from package.json
  const pkgJson = loadPackageJson(projectRoot);
  if (pkgJson) {
    const allDeps = new Set([
      ...Object.keys(pkgJson.dependencies || {}),
      ...Object.keys(pkgJson.devDependencies || {}),
      ...Object.keys(pkgJson.peerDependencies || {}),
      ...Object.keys(pkgJson.optionalDependencies || {}),
    ]);

    const compiledPatterns = getCompiledPatterns(projectRoot, allDeps);
    const lines = file.content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      for (const { pkg, mention, patterns } of compiledPatterns) {
        let matched = false;
        for (const pattern of patterns) {
          if (pattern.test(line)) {
            matched = true;
            break;
          }
        }
        if (matched) {
          const wastedTokens = countTokens(line.trim());
          issues.push({
            severity: 'info',
            check: 'redundancy',
            ruleId: 'redundancy/tech-mention',
            line: i + 1,
            message: `"${mention}" is in package.json ${pkgJson.dependencies?.[pkg] ? 'dependencies' : pkgJson.devDependencies?.[pkg] ? 'devDependencies' : pkgJson.peerDependencies?.[pkg] ? 'peerDependencies' : 'optionalDependencies'} — agent can infer this`,
            suggestion: `~${wastedTokens} tokens could be saved`,
          });
        }
      }
    }
  }

  // Check 2: Directory structure descriptions that match actual structure
  const lines = file.content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match patterns like "Components are in src/components/" or "Tests go in tests/"
    const dirMatch = line.match(
      /(?:are|go|live|found|located|stored)\s+(?:in|at|under)\s+[`"]?(\S+\/)[`"]?/i,
    );
    if (dirMatch) {
      const dir = dirMatch[1].replace(/[`"]/g, '');
      const fullPath = path.resolve(projectRoot, dir);
      if (isDirectory(fullPath)) {
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
const DUPLICATE_CONTENT_MIN_TOKEN_LEN = 10;

export function checkDuplicateContent(files: ParsedContextFile[]): LintIssue[] {
  const issues: LintIssue[] = [];

  // Precompute the non-trivial-line set once per file. The previous code
  // went through `jaccardSimilarity(contentA, contentB)` per pair, which
  // built two Sets each call; with N files that's 2 * N*(N-1)/2 = N*(N-1)
  // Set builds. Pre-building gets us back to N.
  const lineSets = files.map((f) => toLineSet(f.content, DUPLICATE_CONTENT_MIN_TOKEN_LEN));

  for (let i = 0; i < files.length; i++) {
    const a = lineSets[i];
    if (a.size === 0) continue;
    for (let j = i + 1; j < files.length; j++) {
      const b = lineSets[j];
      if (b.size === 0) continue;
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
