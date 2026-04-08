import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkCiSecrets } from '../ci-secrets.js';
import type { ParsedContextFile } from '../../types.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeFile(relativePath: string, content: string): ParsedContextFile {
  return {
    filePath: `/project/${relativePath}`,
    relativePath,
    isSymlink: false,
    totalTokens: 0,
    totalLines: content.split('\n').length,
    content,
    sections: [],
    references: { paths: [], commands: [] },
  };
}

describe('checkCiSecrets', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ctxlint-ci-secrets-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags undocumented secrets', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
    );

    const files = [makeFile('CLAUDE.md', 'This project uses TypeScript.')];
    const issues = await checkCiSecrets(files, tempDir);

    expect(issues.length).toBe(1);
    expect(issues[0].check).toBe('ci-secrets');
    expect(issues[0].ruleId).toBe('ci/undocumented-secret');
    expect(issues[0].message).toContain('NPM_TOKEN');
  });

  it('returns no issues when secret is documented in context', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
    );

    const files = [
      makeFile('CLAUDE.md', 'CI uses NPM_TOKEN for publishing. Set it with gh secret set.'),
    ];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('ignores GITHUB_TOKEN (built-in)', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'ci.yml'),
      'env:\n  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    );

    const files = [makeFile('CLAUDE.md', 'Nothing here.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('returns no issues when no .github/workflows exists', async () => {
    const files = [makeFile('CLAUDE.md', 'Nothing here.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('flags multiple undocumented secrets', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'deploy.yml'),
      'env:\n  TOKEN: ${{ secrets.NPM_TOKEN }}\n  KEY: ${{ secrets.AWS_ACCESS_KEY }}',
    );

    const files = [makeFile('CLAUDE.md', 'No secrets documented.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(2);

    const names = issues.map((i) => i.message);
    expect(names.some((m) => m.includes('NPM_TOKEN'))).toBe(true);
    expect(names.some((m) => m.includes('AWS_ACCESS_KEY'))).toBe(true);
  });

  it('matches secret name with flexible formatting in context', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  TOKEN: ${{ secrets.NPM_TOKEN }}',
    );

    // Should match even with spaces instead of underscores
    const files = [makeFile('CLAUDE.md', 'The NPM TOKEN is set as a GitHub secret.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('detects secrets across multiple workflow files', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  TOKEN: ${{ secrets.NPM_TOKEN }}',
    );
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'deploy.yml'),
      'env:\n  KEY: ${{ secrets.DEPLOY_KEY }}',
    );

    const files = [makeFile('CLAUDE.md', 'NPM_TOKEN is configured.')];
    const issues = await checkCiSecrets(files, tempDir);

    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('DEPLOY_KEY');
  });
});
