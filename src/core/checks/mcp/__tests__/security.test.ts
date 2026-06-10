import { describe, it, expect } from 'vitest';
import { checkMcpSecurity } from '../security.js';
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
    expect(bearer!.fix).toBeDefined();
    expect(bearer!.fix!.newText).toContain('${API_API_KEY}');
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
});
