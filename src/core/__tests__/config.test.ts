import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

  it('returns null for invalid JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.ctxlintrc'), 'not valid json{{{');
    const config = loadConfig(tmpDir);
    expect(config).toBeNull();
  });
});
