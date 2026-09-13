import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { KNOWN_CONFIG_KEYS, loadConfig } from '../config.js';

const README = fs.readFileSync(path.resolve(__dirname, '../../../README.md'), 'utf-8');

/** Body of the README section starting at `heading`, up to the next heading of any level. */
function readmeSection(heading: string): string {
  const start = README.indexOf(`\n${heading}\n`);
  if (start === -1) throw new Error(`README heading not found: ${heading}`);
  const body = README.slice(start + heading.length + 2);
  const next = body.search(/^#{1,6} /m);
  return next === -1 ? body : body.slice(0, next);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-config-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('returns null when no config file exists', () => {
    const config = loadConfig(tmpDir);
    expect(config).toBeNull();
  });

  it('loads .ctxlintrc', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.ctxlintrc'),
      JSON.stringify({ strict: true, ignore: ['redundancy'] }),
    );
    const config = loadConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.strict).toBe(true);
    expect(config!.ignore).toEqual(['redundancy']);
  });

  it('loads .ctxlintrc.json', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.ctxlintrc.json'),
      JSON.stringify({ checks: ['paths', 'commands'] }),
    );
    const config = loadConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.checks).toEqual(['paths', 'commands']);
  });

  it('prefers .ctxlintrc over .ctxlintrc.json', () => {
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc'), JSON.stringify({ strict: true }));
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc.json'), JSON.stringify({ strict: false }));
    const config = loadConfig(tmpDir);
    expect(config!.strict).toBe(true);
  });

  it('loads token thresholds', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.ctxlintrc'),
      JSON.stringify({
        tokenThresholds: { info: 500, warning: 2000, error: 5000, aggregate: 4000 },
      }),
    );
    const config = loadConfig(tmpDir);
    expect(config!.tokenThresholds).toEqual({
      info: 500,
      warning: 2000,
      error: 5000,
      aggregate: 4000,
    });
  });

  it('throws for invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc'), 'not valid json{{{');
    expect(() => loadConfig(tmpDir)).toThrow('Invalid JSON');
  });

  it('error message includes line and column for invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc'), '{\n  "strict": true,\n  "ignore": [,]\n}');
    expect(() => loadConfig(tmpDir)).toThrow(/line \d+, column \d+/);
  });

  it('throws when config root is a JSON array', () => {
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc'), '[1, 2, 3]');
    expect(() => loadConfig(tmpDir)).toThrow(/expected a JSON object at the root/);
  });

  it('throws when config root is a scalar', () => {
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc'), '"hello"');
    expect(() => loadConfig(tmpDir)).toThrow(/expected a JSON object at the root/);
  });

  it('warns about unknown top-level keys with typo suggestion', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, '.ctxlintrc'),
      JSON.stringify({ chekcs: ['paths'] }), // typo for "checks"
    );
    const config = loadConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(warn).toHaveBeenCalled();
    const messages = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(messages).toContain('chekcs');
    expect(messages).toContain('did you mean "checks"');
    warn.mockRestore();
  });

  it('does not suggest when unknown key is too dissimilar', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc'), JSON.stringify({ license: 'MIT' }));
    loadConfig(tmpDir);
    const messages = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(messages).toContain('license');
    expect(messages).not.toContain('did you mean');
    warn.mockRestore();
  });

  it('accepts empty config object without warning', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc'), '{}');
    const config = loadConfig(tmpDir);
    expect(config).toEqual({});
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when ignoreRules.pathPattern is used with a non-stale-memory check', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, '.ctxlintrc'),
      JSON.stringify({
        ignoreRules: [{ check: 'paths', pathPattern: '^node_modules/' }],
      }),
    );
    loadConfig(tmpDir);
    const messages = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(messages).toContain('pathPattern is only honored for');
    expect(messages).toContain('session-stale-memory');
    warn.mockRestore();
  });

  it('does not warn when ignoreRules.pathPattern is used with session-stale-memory', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(
      path.join(tmpDir, '.ctxlintrc'),
      JSON.stringify({
        ignoreRules: [{ check: 'session-stale-memory', pathPattern: '^archive/' }],
      }),
    );
    loadConfig(tmpDir);
    const messages = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(messages).not.toContain('pathPattern is only honored for');
    warn.mockRestore();
  });
});

describe('README Config File section', () => {
  // The README table is the only reference for these keys, and it went two
  // keys short (ignoreRules, hooksGlobal) with nothing noticing (#64). Rows are
  // matched by their first cell; dotted and `[]` rows document sub-fields.
  it('Config Reference lists exactly the keys loadConfig accepts', () => {
    const fields = readmeSection('### Config Reference')
      .split('\n')
      .map((line) => line.match(/^\|\s*`([^`]+)`\s*\|/)?.[1])
      .filter((f): f is string => f !== undefined);
    const topLevel = fields.filter((f) => !/[.[]/.test(f));
    expect([...topLevel].sort()).toEqual([...KNOWN_CONFIG_KEYS].sort());
    // Every sub-field row hangs off a documented key.
    for (const f of fields.filter((f) => /[.[]/.test(f))) {
      expect(KNOWN_CONFIG_KEYS).toContain(f.split(/[.[]/)[0]);
    }
  });

  it('the example config loads without unknown-key or ignoreRules warnings', () => {
    const example = readmeSection('## Config File').match(/```json\n([\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc.json'), example!);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = loadConfig(tmpDir);
      expect(config?.ignoreRules?.length).toBeGreaterThan(0);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
