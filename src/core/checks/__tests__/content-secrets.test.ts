import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkContentSecrets } from '../content-secrets.js';
import type { ParsedContextFile, LintIssue } from '../../types.js';

function makeFile(content: string, relativePath = 'CLAUDE.md'): ParsedContextFile {
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

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ctxlint-content-secrets-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function expectIssue(issues: LintIssue[], ruleId: string): LintIssue {
  const found = issues.find((i) => i.ruleId === ruleId);
  expect(
    found,
    `expected issue with ruleId ${ruleId}, got ${JSON.stringify(issues, null, 2)}`,
  ).toBeDefined();
  return found!;
}

describe('checkContentSecrets - positive matches', () => {
  it('flags an AWS access key (AKIA)', async () => {
    // 16 uppercase alphanum chars after AKIA, no "example"/"placeholder" tokens.
    const file = makeFile('See AKIAIOSFODNN7ZZZABCD for prod.\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/aws-access-key');
  });

  it('flags an AWS STS temporary key (ASIA)', async () => {
    const file = makeFile('Temp creds: ASIAIOSFODNN7ZTEMABC valid 1h.\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/aws-access-key');
  });

  it('flags a GitHub classic PAT (ghp_)', async () => {
    const file = makeFile('Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/github-pat');
  });

  it('flags a GitHub fine-grained PAT (github_pat_)', async () => {
    const tail = 'A'.repeat(82);
    const file = makeFile(`Token: github_pat_${tail}\n`);
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/github-pat');
  });

  it('flags ghs_ / gho_ / ghu_ / ghr_ tokens', async () => {
    const tail = 'b'.repeat(36);
    for (const prefix of ['ghs_', 'gho_', 'ghu_', 'ghr_']) {
      const file = makeFile(`Token: ${prefix}${tail}\n`);
      const issues = await checkContentSecrets(file, tmpDir);
      expectIssue(issues, 'content-secrets/github-pat');
    }
  });

  it('flags an Anthropic API key (sk-ant-)', async () => {
    const file = makeFile('Anthropic: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/anthropic-key');
  });

  it('flags an OpenAI API key (sk-)', async () => {
    const file = makeFile('OpenAI: sk-aBcDeFgHiJkLmNoPqRsTuVwX\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/openai-key');
  });

  it('flags an OpenAI project key (sk-proj-)', async () => {
    const file = makeFile('OpenAI proj: sk-proj-aBcDeFgHiJkLmNoPqRsTuVwXyZ\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/openai-key');
  });

  it('flags an npm automation token (npm_)', async () => {
    const tail = 'a'.repeat(36);
    const file = makeFile(`Token: npm_${tail}\n`);
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/npm-token');
  });

  it('flags a Slack bot token (xoxb-)', async () => {
    const file = makeFile('Slack: xoxb-1234567890-abcdefghijklm\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/slack-token');
  });

  it('flags a Google API key (AIza)', async () => {
    const tail = 'a'.repeat(35);
    const file = makeFile(`Google: AIza${tail}\n`);
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/google-api-key');
  });

  it('flags a private key header', async () => {
    const file = makeFile('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB...\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/private-key-header');
  });

  it('flags an OPENSSH private key header', async () => {
    const file = makeFile('-----BEGIN OPENSSH PRIVATE KEY-----\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/private-key-header');
  });

  it('flags a Stripe live secret key', async () => {
    const tail = 'A'.repeat(24);
    const file = makeFile(`Stripe: sk_live_${tail}\n`);
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/stripe-secret');
  });
});

describe('checkContentSecrets - false-positive guards', () => {
  it('does NOT flag a placeholder-wrapped AWS key like ${AKIA...}', async () => {
    const file = makeFile('Use ${AKIAIOSFODNN7EXAMPLE0} from env.\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/aws-access-key')).toBeUndefined();
  });

  it('does NOT flag <your-key> style angle-bracket placeholders', async () => {
    const file = makeFile('Set token to <ghp_yourtokenherewithenoughchars1234567>\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/github-pat')).toBeUndefined();
  });

  it('does NOT flag an AWS key on a line containing "example"', async () => {
    const file = makeFile('Example value: AKIAIOSFODNN7EXAMPLE0\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/aws-access-key')).toBeUndefined();
  });

  it('does NOT flag a ghp_ token on a line containing "placeholder"', async () => {
    const file = makeFile('Placeholder token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/github-pat')).toBeUndefined();
  });

  it('does NOT flag a redacted-style line (REDACTED)', async () => {
    const file = makeFile('Anthropic key (REDACTED): sk-ant-XXXXXXXXXXXXXXXXXXXX\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/anthropic-key')).toBeUndefined();
  });

  it('does NOT flag a line with xxxx-style masking', async () => {
    const file = makeFile('Old token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/github-pat')).toBeUndefined();
  });

  it('does NOT flag an npm_ token on a line marked as a comment + fake', async () => {
    const file = makeFile('# fake: npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/npm-token')).toBeUndefined();
  });

  it('does NOT flag an STS key on a line containing "your-key"', async () => {
    const file = makeFile('Your-key here: ASIAIOSFODNN7ABCDEF12\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/aws-access-key')).toBeUndefined();
  });

  it('does NOT flag a Slack token on an example/placeholder line', async () => {
    const file = makeFile('placeholder Slack: xoxb-1234567890-abcdefghijk\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/slack-token')).toBeUndefined();
  });

  it('does NOT flag an OpenAI key with `sk-...` ellipsis (too short)', async () => {
    const file = makeFile('Use OpenAI key: sk-...\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/openai-key')).toBeUndefined();
  });

  it('does NOT flag a Stripe key on a line containing "example"', async () => {
    const tail = 'A'.repeat(24);
    const file = makeFile(`Example Stripe: sk_live_${tail}\n`);
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/stripe-secret')).toBeUndefined();
  });

  it('does NOT flag a Google API key on an example line', async () => {
    const tail = 'a'.repeat(35);
    const file = makeFile(`Example: AIza${tail}\n`);
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/google-api-key')).toBeUndefined();
  });

  it('does NOT flag a placeholder private key header (line says example)', async () => {
    const file = makeFile('example -----BEGIN RSA PRIVATE KEY-----\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/private-key-header')).toBeUndefined();
  });
});

describe('checkContentSecrets - never leaks the secret value', () => {
  it('does not include the secret value in message/suggestion/detail', async () => {
    const realLooking = 'AKIAIOSFODNN7QQQABCD';
    const file = makeFile(`See ${realLooking} in prod.\n`);
    const issues = await checkContentSecrets(file, tmpDir);
    const issue = expectIssue(issues, 'content-secrets/aws-access-key');

    expect(issue.message).not.toContain(realLooking);
    expect(issue.suggestion ?? '').not.toContain(realLooking);
    expect(issue.detail ?? '').not.toContain(realLooking);
  });

  it('redacts long secrets to at most a 6-char prefix in the message', async () => {
    const tail = 'B'.repeat(50);
    const secret = `npm_${tail}`;
    const file = makeFile(`Token: ${secret}\n`);
    const issues = await checkContentSecrets(file, tmpDir);
    const issue = expectIssue(issues, 'content-secrets/npm-token');

    expect(issue.message).not.toContain(secret);
    // The redacted prefix may contain at most the first 6 chars of the secret.
    // The first 4 chars (`npm_`) can show; chars 5-6 (`B`s) can too. Char 7+
    // must NOT appear contiguously after the prefix.
    expect(issue.message).not.toContain(secret.slice(0, 8));
  });
});

describe('checkContentSecrets - fenced code blocks', () => {
  it('does NOT flag inside a ```text fenced block (illustrative)', async () => {
    const content = ['Here is an illustration:', '```text', 'AKIAIOSFODNN7EXAMPL9', '```', ''].join(
      '\n',
    );
    const file = makeFile(content);
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/aws-access-key')).toBeUndefined();
  });

  it('DOES flag inside a ```bash fenced block (realistic copy-paste)', async () => {
    const content = [
      'Run this:',
      '```bash',
      'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7REALABC',
      '```',
      '',
    ].join('\n');
    const file = makeFile(content);
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/aws-access-key');
  });

  it('DOES flag inside a ```json fenced block', async () => {
    const content = [
      '```json',
      '{"token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789"}',
      '```',
      '',
    ].join('\n');
    const file = makeFile(content);
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/github-pat');
  });

  it('does NOT flag inside a ```example fence', async () => {
    const content = ['```example', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', '```', ''].join(
      '\n',
    );
    const file = makeFile(content);
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/github-pat')).toBeUndefined();
  });
});

describe('checkContentSecrets - output discipline', () => {
  it('always emits severity=error', async () => {
    const file = makeFile('Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.severity).toBe('error');
      expect(issue.check).toBe('content-secrets');
    }
  });

  it('does not double-flag overlapping Anthropic + OpenAI prefixes on the same offset', async () => {
    // sk-ant-... starts at the same offset as sk- would. Only the more
    // specific Anthropic match should fire.
    const file = makeFile('Key: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv\n');
    const issues = await checkContentSecrets(file, tmpDir);
    const sameLine = issues.filter((i) => i.line === 1);
    expect(sameLine.length).toBe(1);
    expect(sameLine[0].ruleId).toBe('content-secrets/anthropic-key');
  });
});
