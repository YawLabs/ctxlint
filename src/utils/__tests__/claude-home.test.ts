import { join } from 'node:path';
import { homedir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeConfigDir, codexHomeDir, homeDir } from '../claude-home.js';

const KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
let saved: Record<string, string | undefined>;
const originalPlatform = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  setPlatform(originalPlatform);
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('homeDir', () => {
  it('prefers USERPROFILE over HOME on win32, as os.homedir() does', () => {
    setPlatform('win32');
    process.env.HOME = '/git-bash-home';
    process.env.USERPROFILE = 'C:\\Users\\someone';
    expect(homeDir()).toBe('C:\\Users\\someone');
  });

  it('prefers HOME over USERPROFILE elsewhere', () => {
    setPlatform('linux');
    process.env.HOME = '/home/someone';
    process.env.USERPROFILE = '/elsewhere';
    expect(homeDir()).toBe('/home/someone');
  });

  it('falls back to the other variable, then os.homedir()', () => {
    setPlatform('win32');
    process.env.HOME = '/only-home';
    expect(homeDir()).toBe('/only-home');
    delete process.env.HOME;
    expect(homeDir()).toBe(homedir());
  });

  it('is computed per call, not cached', () => {
    setPlatform('linux');
    process.env.HOME = '/a';
    expect(homeDir()).toBe('/a');
    process.env.HOME = '/b';
    expect(homeDir()).toBe('/b');
  });
});

describe('claudeConfigDir', () => {
  it('uses CLAUDE_CONFIG_DIR when set', () => {
    process.env.HOME = '/h';
    process.env.USERPROFILE = '/h';
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude';
    expect(claudeConfigDir()).toBe('/custom/claude');
  });

  it('defaults to <home>/.claude', () => {
    process.env.HOME = '/h';
    process.env.USERPROFILE = '/h';
    expect(claudeConfigDir()).toBe(join('/h', '.claude'));
  });

  it('pins an explicit home to <home>/.claude, ignoring CLAUDE_CONFIG_DIR', () => {
    process.env.CLAUDE_CONFIG_DIR = '/custom/claude';
    expect(claudeConfigDir('/fixture')).toBe(join('/fixture', '.claude'));
    expect(claudeConfigDir('')).toBe('');
  });
});

describe('codexHomeDir', () => {
  it('uses CODEX_HOME when set, else <home>/.codex', () => {
    process.env.HOME = '/h';
    process.env.USERPROFILE = '/h';
    expect(codexHomeDir()).toBe(join('/h', '.codex'));
    process.env.CODEX_HOME = '/custom/codex';
    expect(codexHomeDir()).toBe('/custom/codex');
  });
});
