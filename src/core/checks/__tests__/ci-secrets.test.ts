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

  function writeWorkflow(name: string, content: string): void {
    mkdirSync(join(tempDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(tempDir, '.github', 'workflows', name), content);
  }

  it('treats secrets.github_token as the built-in GITHUB_TOKEN (lookup is case-insensitive)', async () => {
    writeWorkflow('ci.yml', 'env:\n  GH_TOKEN: ${{ secrets.github_token }}');
    const issues = await checkCiSecrets([makeFile('CLAUDE.md', 'Nothing here.')], tempDir);
    expect(issues).toHaveLength(0);
  });

  it('reports one finding for two spellings of the same secret', async () => {
    writeWorkflow('a.yml', 'env:\n  A: ${{ secrets.NPM_TOKEN }}');
    writeWorkflow('b.yml', 'env:\n  B: ${{ secrets.npm_token }}');
    const issues = await checkCiSecrets([makeFile('CLAUDE.md', 'Nothing here.')], tempDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('a.yml, b.yml');
  });

  it('flags ACTIONS_RUNTIME_TOKEN referenced through secrets. (it is a runner env var, not a secret)', async () => {
    writeWorkflow('ci.yml', 'env:\n  T: ${{ secrets.ACTIONS_RUNTIME_TOKEN }}');
    const issues = await checkCiSecrets([makeFile('CLAUDE.md', 'Nothing here.')], tempDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('ACTIONS_RUNTIME_TOKEN');
  });

  it('sees every secret in compound expressions, bracket syntax and if: conditions', async () => {
    writeWorkflow(
      'release.yml',
      [
        'jobs:',
        '  publish:',
        "    if: secrets.EEE != ''",
        '    steps:',
        '      - env:',
        '          T1: ${{ secrets.AAA || secrets.BBB }}',
        '          T2: ${{ inputs.token || secrets.CCC }}',
        "          T3: ${{ secrets['DDD'] }}",
      ].join('\n'),
    );
    const issues = await checkCiSecrets([makeFile('CLAUDE.md', 'Nothing here.')], tempDir);
    const names = issues.map((i) => /"(\w+)"/.exec(i.message)![1]).sort();
    expect(names).toEqual(['AAA', 'BBB', 'CCC', 'DDD', 'EEE']);
  });

  it('ignores secrets on commented-out YAML lines', async () => {
    writeWorkflow(
      'release.yml',
      'env:\n  # OLD: ${{ secrets.OLD_TOKEN }}\n  NEW: ${{ secrets.NEW_TOKEN }} # was secrets.OTHER_TOKEN',
    );
    const issues = await checkCiSecrets([makeFile('CLAUDE.md', 'Nothing here.')], tempDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NEW_TOKEN');
  });

  it('still sees a secret on a #-prefixed line inside a run: block (GitHub expands it there)', async () => {
    writeWorkflow(
      'release.yml',
      'jobs:\n  a:\n    steps:\n      - run: |\n          # login\n          echo ${{ secrets.SHELL_TOKEN }} | docker login\n          # ${{ secrets.COMMENT_TOKEN }}\n',
    );
    const issues = await checkCiSecrets([makeFile('CLAUDE.md', 'Nothing here.')], tempDir);
    const names = issues.map((i) => /"(\w+)"/.exec(i.message)![1]).sort();
    expect(names).toEqual(['COMMENT_TOKEN', 'SHELL_TOKEN']);
  });

  it('does NOT count prose "API key" as documenting a generic two-word secret (API_KEY)', async () => {
    writeWorkflow('deploy.yml', 'env:\n  K: ${{ secrets.API_KEY }}');
    const issues = await checkCiSecrets(
      [makeFile('CLAUDE.md', 'Never commit an API key to the repo.')],
      tempDir,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('API_KEY');
  });

  it('counts an exact env-style or backticked mention for a generic two-word secret', async () => {
    writeWorkflow('deploy.yml', 'env:\n  K: ${{ secrets.API_KEY }}');
    for (const doc of [
      'Set API_KEY in repo secrets.',
      'The deploy reads `api_key` from secrets.',
    ]) {
      const issues = await checkCiSecrets([makeFile('CLAUDE.md', doc)], tempDir);
      expect(issues, doc).toHaveLength(0);
    }
  });

  // A command span that merely contains the word is not documentation.
  it('does NOT count a code span that only contains a generic name (`gh auth token`)', async () => {
    writeWorkflow('ci.yml', 'env:\n  AUTH: ${{ secrets.TOKEN }}\n  K: ${{ secrets.API_KEY }}');
    const issues = await checkCiSecrets(
      [makeFile('CLAUDE.md', 'Log in with `gh auth token` and `export api_key_file=x`.')],
      tempDir,
    );
    expect(issues.map((i) => /"(\w+)"/.exec(i.message)![1]).sort()).toEqual(['API_KEY', 'TOKEN']);
  });

  it('counts a code span that is the generic name in $NAME / secrets.NAME / NAME= form', async () => {
    writeWorkflow('ci.yml', 'env:\n  AUTH: ${{ secrets.TOKEN }}');
    for (const doc of [
      'Read `$token` at runtime.',
      'Read `${token}` at runtime.',
      'Configure `token=<value>` in .env.',
      'Use ` token ` here.',
    ]) {
      const issues = await checkCiSecrets([makeFile('CLAUDE.md', doc)], tempDir);
      expect(issues, doc).toHaveLength(0);
    }
  });

  it('does not count a separator-less run-on (npmtoken) as documenting NPM_TOKEN', async () => {
    writeWorkflow('release.yml', 'env:\n  T: ${{ secrets.NPM_TOKEN }}');
    const issues = await checkCiSecrets([makeFile('CLAUDE.md', 'Uses npmtoken.')], tempDir);
    expect(issues).toHaveLength(1);
  });

  it('reads CRLF workflows', async () => {
    writeWorkflow(
      'release.yml',
      'env:\r\n  # X: ${{ secrets.OLD }}\r\n  T: ${{ secrets.NPM_TOKEN }}\r\n',
    );
    const issues = await checkCiSecrets([makeFile('CLAUDE.md', 'Nothing here.')], tempDir);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('NPM_TOKEN');
  });
});
