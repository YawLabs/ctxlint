import { describe, it, expect } from 'vitest';
import { checkContentSecrets, redactSecrets } from '../content-secrets.js';
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

// The check never touches the filesystem; the root is passed only to match
// the shared check signature.
const tmpDir = '/project';

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

  it('flags a PGP private key block header', async () => {
    const file = makeFile('-----BEGIN PGP PRIVATE KEY BLOCK-----\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/private-key-header');
  });

  it('flags an encrypted PKCS#8 private key header', async () => {
    const file = makeFile('-----BEGIN ENCRYPTED PRIVATE KEY-----\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/private-key-header');
  });

  it('flags a token under a markdown heading that says "Fake" (# is a heading, not a comment)', async () => {
    const file = makeFile('## Fake tokens: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/github-pat');
  });

  // A one-line ```npm test``` is an inline code span, not a fence opener, so it
  // must not put the heading below inside a "fence" where # reads as a comment.
  it('flags a "Fake" heading after a one-line triple-backtick span', async () => {
    const file = makeFile(
      'Run ```npm test``` first.\n\n## Fake tokens: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/github-pat');
  });

  it('flags a "Fake" heading after a line that is only a one-line triple-backtick span', async () => {
    const file = makeFile(
      '```npm test```\n\n## Fake tokens: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n',
    );
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/github-pat');
  });

  it('still honours a // comment marked fake outside a fence', async () => {
    const file = makeFile('// fake: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/github-pat')).toBeUndefined();
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

  it('does NOT flag an npm_ token on a fenced shell comment marked fake', async () => {
    const file = makeFile('```bash\n# fake: npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n```\n');
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

  it('does NOT flag an all-lowercase hyphenated sk- name as an OpenAI key', async () => {
    const file = makeFile('Wrap it with the sk-learn-compatible-estimator-api adapter.\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/openai-key')).toBeUndefined();
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

describe('checkContentSecrets - angle-bracket wrapper vs comparison operators', () => {
  it('DOES flag a key straddled by unrelated < and > comparison operators', async () => {
    // The stray '<' before and '>' after the match are operators, not a
    // placeholder wrapper -- the boundary whitespace gives them away.
    const file = makeFile('if retries < max then key AKIAIOSFODNN7ZZZABCD and timeout > 30\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/aws-access-key');
  });

  it('DOES flag a key between a stray < and an unrelated <docs> tag', async () => {
    // The first '>' after the stray '<' belongs to a different bracket pair
    // (the span contains another '<'), so it is not an enclosing wrapper.
    const file = makeFile('threshold<5 limits AKIAIOSFODNN7ZZZABCD see <docs>\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/aws-access-key');
  });

  it('DOES flag a real-shaped key inside HTML tags like <td>...</td>', async () => {
    const file = makeFile('<td>AKIAIOSFODNN7ZZZABCD</td>\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/aws-access-key');
  });

  it('does NOT flag a key inside a tight multi-word angle-bracket placeholder', async () => {
    // Internal spaces are fine for a wrapper -- only boundary whitespace
    // (operator-shaped) disqualifies the pair.
    const file = makeFile('Set it to <my AKIAIOSFODNN7ZZZABCD value goes here>\n');
    const issues = await checkContentSecrets(file, tmpDir);
    expect(issues.find((i) => i.ruleId === 'content-secrets/aws-access-key')).toBeUndefined();
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

  it('DOES flag inside a bare ``` fence (untagged is not illustrative)', async () => {
    // A bare fence is the most common way .env contents get pasted into a
    // CLAUDE.md -- it must be scanned like any executable-language fence.
    const content = ['My env:', '```', 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7REALABC', '```', ''].join(
      '\n',
    );
    const file = makeFile(content);
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/aws-access-key');
  });

  it('DOES flag a private key header inside a bare ``` fence', async () => {
    const content = ['```', '-----BEGIN RSA PRIVATE KEY-----', 'MIIEpAIB...', '```', ''].join('\n');
    const file = makeFile(content);
    const issues = await checkContentSecrets(file, tmpDir);
    expectIssue(issues, 'content-secrets/private-key-header');
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

describe('redactSecrets', () => {
  const GHP = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  const SAMPLES = [
    'AKIAIOSFODNN7ZZZABCD',
    'ASIAIOSFODNN7ZTEMABC',
    GHP,
    `github_pat_${'A1b2C3d4E5'.repeat(9)}`,
    'ghs_abcdefghijklmnopqrstuvwxyz0123456789',
    'gho_abcdefghijklmnopqrstuvwxyz0123456789',
    'ghu_abcdefghijklmnopqrstuvwxyz0123456789',
    'ghr_abcdefghijklmnopqrstuvwxyz0123456789',
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv',
    'sk-proj-AbCdEfGhIjKlMnOpQrStUv0123',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'xoxb-1234567890-abcdefghij',
    'AIzaSyA1234567890abcdefghijklmnopqrstuv',
    // Assembled at runtime so GitHub push protection does not read the
    // fixture as a live Stripe key (same pattern as the cases above).
    `sk_live_${'abcdefghijklmnopqrstuvwx'}`,
    // Full-length tokens followed by a path separator or an extension: the
    // file-name exemption applies only to sub-floor matches.
    'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX123/foo',
    'npm_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8.json',
    'ASIAABCDEFGHIJKLMNOP/x',
  ];

  it('replaces every known secret format with its short redacted prefix', () => {
    for (const secret of SAMPLES) {
      const out = redactSecrets(`curl -H "Authorization: Bearer ${secret}" https://x`);
      expect(out, secret).not.toContain(secret);
      expect(out, secret).toContain(`Bearer ${secret.slice(0, 6)}...`);
    }
  });

  it('redacts a token cut short by a caller truncating the surrounding text', () => {
    // tier-tokens echoes line.slice(0, 80): a token straddling the cut keeps
    // most of its body but falls below the detector's 36-char floor.
    const truncated = GHP.slice(0, 30);
    const out = redactSecrets(`NEVER run \`curl -H "Bearer ${truncated}`);
    expect(out).not.toContain(truncated);
  });

  it('still redacts truncated real tokens of the guarded formats', () => {
    // Cut short of the detection floor, but random-looking (digits / mixed
    // case), so they are still treated as tokens.
    for (const cut of ['sk-proj-AbCdEf12', 'npm_abcdefgh1234', 'ASIAIOSFODNN7Z']) {
      const out = redactSecrets(`NEVER run \`curl -H "Bearer ${cut}`);
      expect(out, cut).not.toContain(cut);
      expect(out, cut).toContain(`${cut.slice(0, 6)}...`);
    }
  });

  it('redacts full-length guarded tokens even without a digit', () => {
    for (const secret of [`npm_${'a'.repeat(36)}`, `ASIA${'Q'.repeat(16)}`]) {
      expect(redactSecrets(`token ${secret} here`), secret).toBe(
        `token ${secret.slice(0, 6)}... here`,
      );
    }
  });

  it('is idempotent', () => {
    const text = SAMPLES.join(' and ') + ` then ${GHP}_tail sk-ant-${'x'.repeat(30)}`;
    const once = redactSecrets(text);
    expect(redactSecrets(once)).toBe(once);
    for (const secret of SAMPLES) expect(once).not.toContain(secret);
  });

  it('returns ordinary text unchanged', () => {
    const plain = [
      'src/foo.ts does not exist -- did you mean src/bar.ts?',
      '"npm run build" is masked by `|| true`; skill "desk-review" and task-runner-x',
      'Server "github" has a hardcoded API key in a git-tracked file',
      'AKIA alone, ghp_ alone, sk- alone, sk-short, npm_ci',
      'sk-dashboard and sk-learn-lint are skill names',
      'echo $npm_lifecycle_event in the hook',
      'Region ASIAPACIFICREGIONS is not a key',
      'run scripts/sk-Deploy2026.sh then open docs/sk-Guide2.md',
      'see sk-learn-compatible-estimator-api',
      // Ordinary identifiers that happen to carry a digit.
      'pin sk-learn-v2-compat in requirements',
      'see sk-2024-roadmap-v3 for the plan',
      'the ASIA2025SUMMIT keynote',
      'region ASIAPACIFIC2 is live',
    ];
    for (const s of plain) expect(redactSecrets(s)).toBe(s);
  });

  it('runs in linear time on adversarial input', () => {
    const inputs = [
      'sk-'.repeat(100_000),
      'xoxb-'.repeat(100_000) + '!',
      'ghp_'.repeat(100_000),
      'sk-a'.repeat(100_000) + '_',
      'AKIA'.repeat(100_000),
      'sk-A'.repeat(100_000) + '/',
      'npm_1'.repeat(100_000) + '.x',
    ];
    const start = Date.now();
    for (const s of inputs) redactSecrets(s);
    // Generous ceiling for a loaded machine; a quadratic scan of 300-500k
    // chars takes minutes, not seconds.
    expect(Date.now() - start).toBeLessThan(5000);
  });
});
