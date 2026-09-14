import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadIgnoreFile } from '../ignore-file.js';
import { ALL_CHECKS, ALL_MCP_CHECKS, ALL_SESSION_CHECKS, ALL_SKILL_CHECKS } from '../audit.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxlint-ignore-file-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const load = (content: string) => {
  fs.writeFileSync(path.join(root, '.ctxlintignore'), content);
  return loadIgnoreFile(root);
};

describe('loadIgnoreFile', () => {
  it('returns [] when the file does not exist', () => {
    expect(loadIgnoreFile(root)).toEqual([]);
  });

  it('reads check, optional glob and inline reason; skips blanks and comments', () => {
    expect(load('# comment\n\npaths\ntokens CLAUDE.md # noisy\r\n  redundancy src/**  \n')).toEqual(
      [
        { check: 'paths', reason: undefined },
        { check: 'tokens', reason: 'noisy', _fileGlob: 'CLAUDE.md' },
        { check: 'redundancy', reason: undefined, _fileGlob: 'src/**' },
      ],
    );
  });

  it('needs a space before # to start a reason, and ignores tokens after the glob', () => {
    expect(load('paths#legacy\ntokens a.md b.md c.md\n')).toEqual([
      { check: 'paths#legacy', reason: undefined },
      { check: 'tokens', reason: undefined, _fileGlob: 'a.md' },
    ]);
  });
});

describe('README .ctxlintignore section', () => {
  // The README section is the only description of this file format (#64
  // follow-up). Its example must parse into rules that name real checks, or it
  // teaches a line that silently never fires.
  it('example lines parse into rules with real check names and reasons', () => {
    const readme = fs.readFileSync(path.resolve(__dirname, '../../../README.md'), 'utf-8');
    const section = readme
      .split('\n### Ignore file (`.ctxlintignore`)\n')[1]
      ?.split(/\n#{2,3} /)[0];
    const example = section?.match(/```gitignore\n([\s\S]*?)\n```/)?.[1];
    expect(example).toBeDefined();

    const rules = load(example!);
    const known = new Set<string>([
      ...ALL_CHECKS,
      ...ALL_MCP_CHECKS,
      ...ALL_SESSION_CHECKS,
      ...ALL_SKILL_CHECKS,
    ]);
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const rule of rules) {
      expect(known, `unknown check "${rule.check}"`).toContain(rule.check);
      expect(rule.reason, `rule "${rule.check}" has no reason`).toBeTruthy();
    }
    expect(rules.some((r) => r._fileGlob !== undefined)).toBe(true);
    expect(rules.some((r) => r._fileGlob === undefined)).toBe(true);
  });
});
