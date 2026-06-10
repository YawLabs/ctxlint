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
    expect(issues[0].ruleId).toBe('ci-secrets/undocumented-secret');
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

  it('does NOT count lowercase prose as documenting a generic secret name (TOKEN)', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  AUTH: ${{ secrets.TOKEN }}',
    );

    // The word "token" in ordinary prose says nothing about a workflow
    // secret literally named TOKEN.
    const files = [makeFile('CLAUDE.md', 'Request a token from the dashboard to authenticate.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('TOKEN');
  });

  it('counts an exact uppercase mention as documenting a generic secret name', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  AUTH: ${{ secrets.TOKEN }}',
    );

    const files = [makeFile('CLAUDE.md', 'Set TOKEN with `gh secret set TOKEN`.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('counts a secrets.<name> reference as documenting a generic secret name', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  AUTH: ${{ secrets.TOKEN }}',
    );

    // Case-insensitive: the explicit secrets. prefix is unambiguous.
    const files = [
      makeFile('CLAUDE.md', 'The release workflow reads secrets.token from repo settings.'),
    ];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('does NOT count lowercase prose for a lowercase-written generic reference', async () => {
    // GitHub secret lookups are case-insensitive, so `${{ secrets.token }}`
    // is a valid reference and the captured name arrives lowercase. The
    // exact-case probe must still demand the conventional uppercase form —
    // an as-written probe would let any prose "token" count as docs.
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  AUTH: ${{ secrets.token }}',
    );

    const files = [makeFile('CLAUDE.md', 'Request a token from the dashboard to authenticate.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('token');
  });

  it('counts an uppercase doc mention for a lowercase-written generic reference', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  AUTH: ${{ secrets.token }}',
    );

    const files = [makeFile('CLAUDE.md', 'Set TOKEN with `gh secret set TOKEN`.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('counts a secrets.<name> doc reference for a lowercase-written generic reference', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  AUTH: ${{ secrets.token }}',
    );

    // secretsRef stays case-insensitive so the as-written form still counts.
    const files = [
      makeFile('CLAUDE.md', 'The release workflow reads secrets.token from repo settings.'),
    ];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('does NOT count prose "key" for a short generic secret name (KEY)', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'deploy.yml'),
      'env:\n  K: ${{ secrets.KEY }}',
    );

    const files = [makeFile('CLAUDE.md', 'Rotate the signing key every quarter.')];
    const issues = await checkCiSecrets(files, tempDir);
    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('KEY');
  });

  it('keeps the loose case-insensitive match for multi-token names (NPM_TOKEN)', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'release.yml'),
      'env:\n  TOKEN: ${{ secrets.NPM_TOKEN }}',
    );

    const files = [makeFile('CLAUDE.md', 'CI publishes with the npm token stored as a secret.')];
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
