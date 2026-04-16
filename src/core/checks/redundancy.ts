import * as path from 'node:path';
import { isDirectory, loadPackageJson } from '../../utils/fs.js';
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

    // Pre-compile all regex patterns once
    const compiledPatterns = compilePatterns(allDeps);
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

export function checkDuplicateContent(files: ParsedContextFile[]): LintIssue[] {
  const issues: LintIssue[] = [];

  // Threshold of 0.6 Jaccard similarity ≈ "at least 60% of the union of
  // non-trivial lines is shared between the two files." This is strict
  // enough not to trip on files that happen to share boilerplate (a
  // common disclaimer, a shared heading structure) and loose enough to
  // catch AGENTS.md / CLAUDE.md pairs that were copy-pasted and lightly
  // diverged — the most common reason for duplicate context files. Uses
  // `>=` so a pair that lands exactly on the line still gets reported.
  const DUPLICATE_CONTENT_THRESHOLD = 0.6;

  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      const overlap = calculateLineOverlap(files[i].content, files[j].content);
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

/**
 * Jaccard similarity over non-trivial lines (trimmed, > 10 chars). Returns
 * |A ∩ B| / |A ∪ B| in [0, 1]. Earlier versions divided by
 * `max(|A|, |B|)` ("overlap coefficient over max"), which inflates the
 * score when one file is much smaller than the other and doesn't match
 * the metric the user-facing message reports ("content overlap").
 */
function calculateLineOverlap(contentA: string, contentB: string): number {
  const linesA = new Set(
    contentA
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 10),
  );
  const linesB = new Set(
    contentB
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 10),
  );

  if (linesA.size === 0 || linesB.size === 0) return 0;

  let intersection = 0;
  for (const line of linesA) {
    if (linesB.has(line)) intersection++;
  }
  const unionSize = linesA.size + linesB.size - intersection;
  return intersection / unionSize;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
