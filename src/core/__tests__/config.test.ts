import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadConfig } from '../config.js';

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
});
