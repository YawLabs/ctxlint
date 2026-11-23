import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkMcpSecurity } from '../security.js';
import { parseMcpContent } from '../../../mcp-parser.js';
import { applyFixes } from '../../../fixer.js';
import type { ParsedMcpConfig } from '../../../types.js';

function makeConfig(overrides: Partial<ParsedMcpConfig> = {}): ParsedMcpConfig {
  return {
    filePath: '/project/.mcp.json',
    relativePath: '.mcp.json',
    client: 'claude-code',
    scope: 'project',
    expectedRootKey: 'mcpServers',
    actualRootKey: 'mcpServers',
    servers: [],
    parseErrors: [],
    content: '{}',
    isGitTracked: true,
    ...overrides,
  };
}

describe('checkMcpSecurity', () => {
  it('flags hardcoded Bearer token', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const bearer = issues.find((i) => i.message.includes('hardcoded Bearer token'));
    expect(bearer).toBeDefined();
    expect(bearer!.severity).toBe('error');
    // A hand-built config has no source text to anchor a fix in; the fix
    // itself is covered by the parsed-source tests at the end of this file.
    expect(bearer!.fix).toBeUndefined();
    // One finding per header: the token also matches the known-pattern rule,
    // which must not double-report on top of hardcoded-bearer.
    expect(issues.filter((i) => i.check === 'mcp-security')).toHaveLength(1);
  });

  it('flags sk-proj key in a non-Authorization header (known-pattern path)', async () => {
    // Exercises API_KEY_PATTERNS directly: non-Authorization headers have no
    // bearer rule and no name+entropy fallback, so only the pattern can fire.
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            'X-Api-Key': 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.ruleId === 'mcp-security/hardcoded-api-key');
    expect(apiKey).toBeDefined();
    expect(apiKey!.severity).toBe('error');
  });

  it('flags sk-ant key in env under a non-secret-suggesting name (known-pattern path)', async () => {
    // "ANTHROPIC" carries no SECRET_NAME_KEYWORDS hit, so the entropy
    // fallback can't fire -- only the sk-ant- pattern catches this.
    const config = makeConfig({
      servers: [
        {
          name: 'anthropic',
          transport: 'stdio',
          command: 'npx',
          env: {
            ANTHROPIC: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz12345678',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcp-security/hardcoded-api-key')).toBeDefined();
  });

  it('does not flag kebab-case identifiers starting with sk-', async () => {
    // Neither value is a secret, and neither name carries a
    // SECRET_NAME_KEYWORDS hit, so only the generic sk- pattern could fire --
    // and a false positive here triggers the destructive env-var autofix.
    const config = makeConfig({
      servers: [
        {
          name: 'service',
          transport: 'stdio',
          command: 'npx',
          env: {
            DEPLOY_CHANNEL: 'sk-canary-deployment-2026',
            DOCS_URL: 'https://example.com/sk-some-long-path-name-here',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-security/hardcoded-api-key')).toHaveLength(0);
  });

  it('flags classic alphanumeric sk- key in env (known-pattern path)', async () => {
    // "OPENAI" carries no SECRET_NAME_KEYWORDS hit, so only the generic
    // sk-[a-zA-Z0-9]{20,} pattern can catch this.
    const config = makeConfig({
      servers: [
        {
          name: 'openai',
          transport: 'stdio',
          command: 'npx',
          env: {
            OPENAI: 'sk-abcdefghijklmnopqrstuvwxyz123456',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.ruleId === 'mcp-security/hardcoded-api-key');
    expect(apiKey).toBeDefined();
    expect(apiKey!.severity).toBe('error');
  });

  it('does not flag a value merely containing "sk-" mid-word', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'service',
          transport: 'stdio',
          command: 'npx',
          env: {
            PIPELINE: 'whisk-data-pipeline-tools-v2-extra-long-slug',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-security/hardcoded-api-key')).toHaveLength(0);
  });

  it('does not flag Bearer with env var reference', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer ${API_KEY}',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('Bearer'))).toHaveLength(0);
  });

  it('flags known API key patterns in env', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'github-server',
          transport: 'stdio',
          command: 'npx',
          env: {
            GITHUB_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.message.includes('hardcoded API key'));
    expect(apiKey).toBeDefined();
    expect(apiKey!.severity).toBe('error');
  });

  it('flags secrets in URL query params', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp?api_key=mySecret123',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const urlSecret = issues.find((i) => i.message.includes('secret in the URL'));
    expect(urlSecret).toBeDefined();
    expect(urlSecret!.severity).toBe('error');
  });

  it('flags HTTP without TLS for non-localhost', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'insecure',
          transport: 'http',
          url: 'http://api.production.example.com/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const httpIssue = issues.find((i) => i.message.includes('HTTP without TLS'));
    expect(httpIssue).toBeDefined();
    expect(httpIssue!.severity).toBe('warning');
  });

  it('does not flag HTTP for localhost', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'local',
          transport: 'http',
          url: 'http://localhost:3000/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('HTTP without TLS'))).toHaveLength(0);
  });

  it('does not flag HTTP for IPv6 loopback', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'local6',
          transport: 'http',
          url: 'http://[::1]/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('HTTP without TLS'))).toHaveLength(0);
  });

  it('does not flag HTTP for 127.0.0.0/8 loopback', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'local127',
          transport: 'http',
          url: 'http://127.0.0.2/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('HTTP without TLS'))).toHaveLength(0);
  });

  it('flags HTTP for a public host masquerading as loopback (127.evil.com)', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'fakeloop',
          transport: 'http',
          url: 'http://127.evil.com/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('HTTP without TLS'))).toHaveLength(1);
  });

  it('skips secret rules for non-git-tracked files', async () => {
    const config = makeConfig({
      isGitTracked: false,
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('reports secret-scan-skipped at info when tracking is unknown', async () => {
    // gitTrackedUnknown means git could not ANSWER (unavailable/failing),
    // distinct from the determined-untracked case above, which stays silent.
    const config = makeConfig({
      isGitTracked: false,
      gitTrackedUnknown: true,
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('mcp-security/secret-scan-skipped');
    expect(issues[0].severity).toBe('info');
    expect(issues[0].message).toContain('.mcp.json');
  });

  it('does not report secret-scan-skipped for determined-untracked or tracked files', async () => {
    const untracked = await checkMcpSecurity(makeConfig({ isGitTracked: false }), '/project');
    const tracked = await checkMcpSecurity(makeConfig({ isGitTracked: true }), '/project');
    expect([...untracked, ...tracked]).toHaveLength(0);
  });

  it('still flags HTTP without TLS in non-git-tracked files', async () => {
    // http-no-tls is a transport concern, not a committed-secret concern --
    // tracking status gates only the secret rules.
    const config = makeConfig({
      isGitTracked: false,
      servers: [
        {
          name: 'insecure',
          transport: 'http',
          url: 'http://api.production.example.com/mcp?api_key=mySecret123',
          headers: {
            Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues).toHaveLength(1);
    expect(issues[0].ruleId).toBe('mcp-security/http-no-tls');
  });

  it('flags high-entropy strings in env values', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'service',
          transport: 'stdio',
          command: 'npx',
          env: {
            SECRET: 'aVeryLongBase64EncodedStringThatLooksLikeASecret123456',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.message.includes('hardcoded API key'));
    expect(apiKey).toBeDefined();
  });

  it('does not flag short safe env values', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'service',
          transport: 'stdio',
          command: 'npx',
          env: {
            DEBUG: 'true',
            LOG_LEVEL: 'info',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues).toHaveLength(0);
  });

  it('does not flag BUILD_ID with high-entropy value (non-secret name)', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'service',
          transport: 'stdio',
          command: 'npx',
          env: {
            BUILD_ID: 'abc123def456ghi789jkl012mno345',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('hardcoded API key'))).toHaveLength(0);
  });

  it('still flags OPENAI_API_KEY with sk- prefix (known pattern)', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'openai',
          transport: 'stdio',
          command: 'npx',
          env: {
            OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.message.includes('hardcoded API key'));
    expect(apiKey).toBeDefined();
    expect(apiKey!.severity).toBe('error');
  });

  it('does not flag SHA-shaped value in non-secret-named variable', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'service',
          transport: 'stdio',
          command: 'npx',
          env: {
            GIT_COMMIT: 'a1b2c3d4e5f6789012345678901234567890abcd',
            APP_VERSION: 'v1.2.3-alpha.4567890abcdef',
            CONTENT_HASH: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.message.includes('hardcoded API key'))).toHaveLength(0);
  });

  // --- A1: secrets in CLI args ---

  it('flags a hardcoded key in --flag=value form in args', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          args: ['server', '--api-key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890'],
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.ruleId === 'mcp-security/hardcoded-api-key');
    expect(apiKey).toBeDefined();
    expect(apiKey!.severity).toBe('error');
  });

  it('flags a hardcoded key in --flag value (separate-element) form in args', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'gh',
          transport: 'stdio',
          command: 'npx',
          args: ['server', '--token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'],
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const apiKey = issues.find((i) => i.ruleId === 'mcp-security/hardcoded-api-key');
    expect(apiKey).toBeDefined();
  });

  it('does not flag an env-ref-only arg value', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'stdio',
          command: 'npx',
          args: ['server', '--api-key=${API_KEY}', '--token', '${TOKEN}'],
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-security/hardcoded-api-key')).toHaveLength(0);
  });

  // --- A2: secret-in-url no longer whole-string-gated by a stray env ref ---

  it('flags a hardcoded api_key in the URL beside an unrelated env ref', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp?api_key=mySecret123&ws=${WS}',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcp-security/secret-in-url')).toBeDefined();
  });

  it('does not flag a URL whose secret param value is itself an env ref', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp?token=${TOK}&region=us',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.filter((i) => i.ruleId === 'mcp-security/secret-in-url')).toHaveLength(0);
  });

  // --- A3: per-value scans no longer disabled by a stray env ref ---

  it('flags a hardcoded Bearer token sitting next to an unrelated env ref', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            // A real token glued to an unrelated ${VAR} must still fire.
            Authorization: 'Bearer sk-proj-abcdefghijklmnopqrstuvwxyz1234567890${UNUSED}',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    const bearer = issues.find((i) => i.message.includes('hardcoded Bearer token'));
    expect(bearer).toBeDefined();
    expect(bearer!.severity).toBe('error');
  });

  it('flags a known key in a non-Authorization header beside an unrelated env ref', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: {
            'X-Api-Key': '${PREFIX}sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcp-security/hardcoded-api-key')).toBeDefined();
  });

  it('flags a known key in env beside an unrelated env ref', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'github-server',
          transport: 'stdio',
          command: 'npx',
          env: {
            GITHUB_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij ${UNUSED}',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.find((i) => i.ruleId === 'mcp-security/hardcoded-api-key')).toBeDefined();
  });

  it('keeps an all-env-ref value safe across header, bearer, env, and url', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp?token=${TOK}',
          headers: {
            Authorization: 'Bearer ${API_KEY}',
            'X-Api-Key': '${API_KEY}',
          },
          env: {
            GITHUB_TOKEN: '${GH_TOKEN}',
          },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(
      issues.filter(
        (i) =>
          i.ruleId === 'mcp-security/hardcoded-bearer' ||
          i.ruleId === 'mcp-security/hardcoded-api-key' ||
          i.ruleId === 'mcp-security/secret-in-url',
      ),
    ).toHaveLength(0);
  });

  // --- name heuristics: whole tokens, non-secret suffixes, path values ---

  it.each([
    ['SSH_KEY_PATH', '/Users/x/ssh/keys/id_ed25519'],
    ['GIT_AUTHOR_NAME', 'ExampleAuthorWithAVeryLongName'],
    ['SESSION_STORE_DIR', 'sessionStoreDirectoryNameHere'],
    ['KEYCHAIN_SERVICE', 'com-example-keychain-service-id'],
    ['SIGNING_KEY', '/etc/keys/release_signing_key_v2'],
    ['PRIVATE_KEY', 'C:/Users/x/keys/private_key_file'],
  ])('does not flag %s = %s', async (envName, envValue) => {
    const config = makeConfig({
      servers: [
        {
          name: 'svc',
          transport: 'stdio',
          command: 'npx',
          env: { [envName]: envValue },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues).toEqual([]);
  });

  it.each([
    'githubToken',
    'OPENAIAPIKEY',
    'db-password',
    'X_AUTH',
    // Separator-less compounds ending in KEY / PASS.
    'SECRETKEY',
    'STRIPE_SECRETKEY',
    'ACCESSKEY',
    'PRIVATEKEY',
    'ENCRYPTIONKEY',
    'AUTHKEY',
    'DBPASS',
  ])('still flags a high-entropy value under %s', async (envName) => {
    const config = makeConfig({
      servers: [
        {
          name: 'svc',
          transport: 'stdio',
          command: 'npx',
          env: { [envName]: 'aVeryLongBase64EncodedStringThatLooksLikeASecret123456' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-security/hardcoded-api-key']);
  });

  it.each(['MONKEY', 'TURKEY_MODE', 'HOTKEY', 'BYPASS', 'COMPASS'])(
    'does not flag a high-entropy value under the ordinary word %s',
    async (envName) => {
      const config = makeConfig({
        servers: [
          {
            name: 'svc',
            transport: 'stdio',
            command: 'npx',
            env: { [envName]: 'aVeryLongBase64EncodedStringThatLooksLikeASecret123456' },
            line: 3,
            raw: {},
          },
        ],
      });
      expect(await checkMcpSecurity(config, '/project')).toEqual([]);
    },
  );

  it.each([
    // A base64 secret that happens to start with `/` (about 1 in 64).
    '/Zq8vT3kLm9Wp2Xr7Yn4Bc6Df1Gh5Jk0QQ',
    // ...even one with a second `/` later, when it also carries `+` or `=`.
    '/Zq8vT3kLm9/p2Xr7Yn4Bc6Df1Gh5Jk0Q+Q==',
  ])('still flags a base64 secret %s that starts with /', async (value) => {
    const config = makeConfig({
      servers: [
        {
          name: 'svc',
          transport: 'stdio',
          command: 'npx',
          env: { API_KEY: value },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-security/hardcoded-api-key']);
  });

  // --- false negatives that now flag ---

  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlhdCI6MTcwMDAwMDAwMH0.abcdefghijklmnopqrstuvwxyz0123';

  it('flags a JWT under SUPABASE_KEY', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'supabase',
          transport: 'stdio',
          command: 'npx',
          env: { SUPABASE_KEY: JWT },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-security/hardcoded-api-key']);
  });

  it('flags Authorization: Basic credentials', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Basic dXNlcjpwYXNzd29yZA==' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-security/hardcoded-api-key']);
  });

  it('does not flag Authorization: Basic ${CREDS}', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Basic ${CREDS}' },
          line: 3,
          raw: {},
        },
      ],
    });
    expect(await checkMcpSecurity(config, '/project')).toEqual([]);
  });

  it('flags a non-prefixed high-entropy X-API-Key value', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { 'X-API-Key': 'q8Zt3LmP0vXa9WcR7yKd2HbN5sFj1GeU' },
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-security/hardcoded-api-key']);
  });

  it('does not flag a high-entropy value under a non-secret header name', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://api.example.com/mcp',
          headers: { 'X-Request-Id': 'q8Zt3LmP0vXa9WcR7yKd2HbN5sFj1GeU' },
          line: 3,
          raw: {},
        },
      ],
    });
    expect(await checkMcpSecurity(config, '/project')).toEqual([]);
  });

  it('flags credentials in URL userinfo', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'api',
          transport: 'http',
          url: 'https://admin:hunter2pass@api.example.com/mcp',
          line: 3,
          raw: {},
        },
      ],
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-security/secret-in-url']);
    expect(issues[0].message).toContain('userinfo');
    expect(issues[0].message).not.toContain('hunter2');
  });

  it('does not flag userinfo whose password is an env ref, or a plain username', async () => {
    const config = makeConfig({
      servers: [
        {
          name: 'a',
          transport: 'http',
          url: 'https://admin:${PW}@api.example.com/mcp',
          line: 3,
          raw: {},
        },
        { name: 'b', transport: 'http', url: 'https://git@example.com/mcp', line: 4, raw: {} },
      ],
    });
    expect(await checkMcpSecurity(config, '/project')).toEqual([]);
  });

  // --- fixes on real (pretty-printed) source ---

  function parsed(json: unknown, relativePath = '.mcp.json'): ParsedMcpConfig {
    const config = parseMcpContent(`${JSON.stringify(json, null, 2)}\n`, {
      filePath: `/project/${relativePath}`,
      relativePath,
      scope: 'project',
    });
    return { ...config, isGitTracked: true };
  }

  it('anchors fixes on the value line and names the variable after the key', async () => {
    const config = parsed({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['server', '--token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'],
          env: {
            GITHUB_TOKEN: 'ghp_ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrq',
            API_KEY: 'aVeryLongBase64EncodedStringThatLooksLikeASecret123456',
          },
        },
      },
    });
    const issues = await checkMcpSecurity(config, '/project');
    const fixes = issues.map((i) => i.fix!);
    expect(fixes.map((f) => f.newText).sort()).toEqual(
      ['${API_KEY}', '${GITHUB_TOKEN}', '${GITHUB_TOKEN_2}'].sort(),
    );
    const lines = config.content.split('\n');
    for (const f of fixes) {
      // Not the server's `"github": {` line, and the column points at oldText.
      expect(f.line).not.toBe(config.servers[0].line);
      expect(lines[f.line - 1].slice(f.column! - 1, f.column! - 1 + f.oldText.length)).toBe(
        f.oldText,
      );
    }
  });

  it('preserves the Authorization scheme text and uses the client syntax', async () => {
    const config = parsed(
      {
        mcpServers: {
          '1password': {
            url: 'https://api.example.com/mcp',
            headers: { Authorization: 'Bearer   sk-proj-abcdefghijklmnopqrstuvwxyz1234567890' },
          },
        },
      },
      '.cursor/mcp.json',
    );
    const [issue] = await checkMcpSecurity(config, '/project');
    expect(issue.ruleId).toBe('mcp-security/hardcoded-bearer');
    expect(issue.fix!.oldText).toBe('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890');
    // Leading digit: prefixed with `_`, never ${1PASSWORD_...}.
    expect(issue.fix!.newText).toBe('${env:_1PASSWORD_TOKEN}');
  });

  it('replaces only the literal residue, keeping a neighbouring ${VAR} (header, env, bearer)', async () => {
    const config = parsed(
      {
        mcpServers: {
          api: {
            url: 'https://api.example.com/mcp',
            headers: {
              'X-Api-Key': 'Pq1Wo2Ei3Ru4Ty5Yu6Io7Pa8Sd9Fg0Hj${SUFFIX}',
              Authorization: 'Bearer ${A} Zq8vT3kLm9Wp2Xr7Yn4Bc6Df1Gh5Jk0QQ',
            },
            env: { API_KEY: '${PREFIX}aVeryLongBase64EncodedStringThatLooksLikeASecret123456' },
          },
        },
      },
      '.cursor/mcp.json',
    );
    const issues = await checkMcpSecurity(config, '/project');
    const oldTexts = issues.map((i) => i.fix?.oldText).sort();
    expect(oldTexts).toEqual(
      [
        'Pq1Wo2Ei3Ru4Ty5Yu6Io7Pa8Sd9Fg0Hj',
        'Zq8vT3kLm9Wp2Xr7Yn4Bc6Df1Gh5Jk0QQ',
        'aVeryLongBase64EncodedStringThatLooksLikeASecret123456',
      ].sort(),
    );
  });

  it('reports but does not fix a value whose literal is split around a ${VAR}', async () => {
    const config = parsed({
      mcpServers: {
        api: {
          command: 'npx',
          env: { API_KEY: 'aVeryLongBase64${MID}EncodedStringThatLooksLike' },
        },
      },
    });
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-security/hardcoded-api-key']);
    expect(issues[0].fix).toBeUndefined();
  });

  it('omits the fix for a client that does not interpolate env refs', async () => {
    const config = parsed(
      {
        mcpServers: {
          gh: { command: 'npx', env: { GITHUB_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij' } },
        },
      },
      '.amazonq/mcp.json',
    );
    const issues = await checkMcpSecurity(config, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['mcp-security/hardcoded-api-key']);
    expect(issues[0].fix).toBeUndefined();
  });

  it('end to end: applyFixes rewrites a pretty-printed .mcp.json into valid JSON', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-sec-fix-'));
    try {
      const filePath = path.join(dir, '.mcp.json');
      const source = {
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', 'server', '--api-key=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890'],
            env: { GITHUB_TOKEN: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij', DEBUG: 'true' },
          },
          remote: {
            url: 'https://api.example.com/mcp',
            headers: { Authorization: 'Bearer ghp_ZYXWVUTSRQPONMLKJIHGFEDCBAzyxwvutsrq' },
          },
        },
      };
      const content = `${JSON.stringify(source, null, 2)}\n`;
      fs.writeFileSync(filePath, content);
      const config = {
        ...parseMcpContent(content, { filePath, relativePath: '.mcp.json', scope: 'project' }),
        isGitTracked: true,
      };
      const issues = await checkMcpSecurity(config, dir);
      expect(issues).toHaveLength(3);
      const summary = applyFixes(
        {
          version: '0',
          scannedAt: '',
          projectRoot: dir,
          files: [{ path: '.mcp.json', isSymlink: false, tokens: 0, lines: 0, issues }],
          summary: { errors: 0, warnings: 0, info: 0, totalTokens: 0, estimatedWaste: 0 },
        },
        { quiet: true },
      );
      expect(summary.totalFixes).toBe(3);
      const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      expect(after.mcpServers.github.args[2]).toBe('--api-key=${GITHUB_API_KEY}');
      expect(after.mcpServers.github.env).toEqual({
        GITHUB_TOKEN: '${GITHUB_TOKEN}',
        DEBUG: 'true',
      });
      expect(after.mcpServers.remote.headers.Authorization).toBe('Bearer ${REMOTE_TOKEN}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
