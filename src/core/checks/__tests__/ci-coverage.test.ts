import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkCiCoverage } from '../ci-coverage.js';
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

describe('checkCiCoverage', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ctxlint-ci-coverage-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags when release workflow exists but context has no release docs', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'release.yml'), 'name: Release\non: push');

    const files = [makeFile('CLAUDE.md', 'This project uses TypeScript.')];
    const issues = await checkCiCoverage(files, tempDir);

    expect(issues.length).toBe(1);
    expect(issues[0].check).toBe('ci-coverage');
    expect(issues[0].ruleId).toBe('ci/no-release-docs');
    expect(issues[0].message).toContain('release.yml');
  });

  it('returns no issues when context documents release process', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'release.yml'), 'name: Release\non: push');

    const files = [makeFile('CLAUDE.md', 'Release process: push a v* tag to trigger CI.')];
    const issues = await checkCiCoverage(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('returns no issues when no .github/workflows exists', async () => {
    const files = [makeFile('CLAUDE.md', 'Just a project.')];
    const issues = await checkCiCoverage(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('returns no issues when only CI test workflows exist (no release)', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push');
    writeFileSync(join(tempDir, '.github', 'workflows', 'lint.yml'), 'name: Lint\non: push');

    const files = [makeFile('CLAUDE.md', 'This project uses TypeScript.')];
    const issues = await checkCiCoverage(files, tempDir);
    expect(issues.length).toBe(0);
  });

  it('detects deploy workflows by filename', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'deploy.yml'), 'name: Build\non: push');

    const files = [makeFile('CLAUDE.md', 'No release info here.')];
    const issues = await checkCiCoverage(files, tempDir);

    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('deploy.yml');
  });

  it('detects release workflows by YAML name field', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'build.yml'),
      'name: Publish to npm\non: push',
    );

    const files = [makeFile('CLAUDE.md', 'No release info here.')];
    const issues = await checkCiCoverage(files, tempDir);

    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('build.yml');
  });

  it('matches various release documentation phrases', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'release.yml'), 'name: Release\non: push');

    const phrases = [
      'Release via CI by pushing a tag',
      'Deploy to production using GitHub Actions',
      'npm publish is handled by CI',
      'Push a v1.0.0 tag to release',
      'git tag v1.0.0 && git push',
      'release.yml handles publishing',
    ];

    for (const phrase of phrases) {
      const files = [makeFile('CLAUDE.md', phrase)];
      const issues = await checkCiCoverage(files, tempDir);
      expect(issues.length).toBe(0);
    }
  });
});
