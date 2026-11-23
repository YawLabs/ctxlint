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
    expect(issues[0].ruleId).toBe('ci-coverage/no-release-docs');
    expect(issues[0].message).toContain('release.yml');
  });

  it('returns no issues when context documents release process', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'release.yml'), 'name: Release\non: push');

    // Pins the rule's own suggested wording: the phrase must be recognised on
    // its own, without a second "Release process" phrase rescuing it.
    const files = [makeFile('CLAUDE.md', 'Push a v* tag to trigger CI.')];
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

  it('detects a quoted YAML name field (single and double quotes)', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'dq.yml'), 'name: "Release"\non: push');
    writeFileSync(join(tempDir, '.github', 'workflows', 'sq.yml'), "name: 'Deploy'\non: push");

    const files = [makeFile('CLAUDE.md', 'No release info here.')];
    const issues = await checkCiCoverage(files, tempDir);

    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('dq.yml');
    expect(issues[0].message).toContain('sq.yml');
  });

  it('detects an indented (leading-whitespace) YAML name field', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'indented.yml'),
      '  name: Release\non: push',
    );

    const files = [makeFile('CLAUDE.md', 'No release info here.')];
    const issues = await checkCiCoverage(files, tempDir);

    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('indented.yml');
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

  it('recognises ordinary release documentation phrasings', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'release.yml'), 'name: Release\non: push');

    const phrases = [
      '## Releasing\n\nRun `./release.sh 1.2.3` from a clean main.',
      'Releases are cut with `npm version patch && git push --follow-tags`.',
      'Deploys to Netlify automatically on merge.',
      'Deployment is handled by Vercel.',
      'CI publishes on tag push.',
      'Push a v* tag to trigger CI.',
      'Push the release tag to trigger CI.',
    ];

    for (const phrase of phrases) {
      const files = [makeFile('CLAUDE.md', phrase)];
      const issues = await checkCiCoverage(files, tempDir);
      expect(issues, phrase).toHaveLength(0);
    }
  });

  it('still flags prose that only mentions the word release in passing', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'release.yml'), 'name: Release\non: push');

    const files = [makeFile('CLAUDE.md', 'See the release notes in CHANGELOG.md for history.')];
    const issues = await checkCiCoverage(files, tempDir);
    expect(issues).toHaveLength(1);
  });

  it('still flags passing mentions that do not say how releases or deploys happen', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', 'release.yml'), 'name: Release\non: push');

    const phrases = [
      'Release notes are in CHANGELOG.md.',
      'The deploy target is staging.',
      'The release is on Friday.',
      'Deployments are on hold this week.',
      'This package is published on npm.',
      '## Release notes\n\nSee CHANGELOG.md.',
      '## Deployment targets\n\nstaging, production',
      'Push to tag-protected branches is blocked.',
      'Never push a tag from a fork.',
      "Don't push the release tag yourself.",
      'Do not push tags.',
    ];

    for (const phrase of phrases) {
      const files = [makeFile('CLAUDE.md', phrase)];
      const issues = await checkCiCoverage(files, tempDir);
      expect(issues, phrase).toHaveLength(1);
    }
  });

  it('reads only the top-level workflow name, not a nested `name:` under a step', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'ci.yml'),
      [
        'on: push',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/upload-artifact@v4',
        '        with:',
        '          name: release-build',
        'name: CI',
      ].join('\n'),
    );

    const files = [makeFile('CLAUDE.md', 'This project uses TypeScript.')];
    const issues = await checkCiCoverage(files, tempDir);
    expect(issues).toHaveLength(0);
  });

  it('does not take a nested `name:` as the workflow name when there is no top-level one', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'ci.yml'),
      'on: push\njobs:\n  build:\n    steps:\n      - name: Deploy preview\n        run: echo hi\n',
    );

    const files = [makeFile('CLAUDE.md', 'This project uses TypeScript.')];
    const issues = await checkCiCoverage(files, tempDir);
    expect(issues).toHaveLength(0);
  });

  it('reads the workflow name from a CRLF file', async () => {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(
      join(tempDir, '.github', 'workflows', 'build.yml'),
      'name: "Publish to npm"\r\non: push\r\n',
    );

    const files = [makeFile('CLAUDE.md', 'No release info here.')];
    const issues = await checkCiCoverage(files, tempDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('build.yml');
  });
});
