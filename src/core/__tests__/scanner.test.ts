import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { scanForContextFiles } from '../scanner.js';

const FIXTURES = path.resolve(__dirname, '../../../fixtures');

describe('scanner', () => {
  it('finds CLAUDE.md in a project', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'healthy-project'));
    expect(files.length).toBe(1);
    expect(files[0].relativePath).toBe('CLAUDE.md');
  });

  it('finds AGENTS.md', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'wrong-commands'));
    expect(files.length).toBe(1);
    expect(files[0].relativePath).toBe('AGENTS.md');
  });

  it('finds multiple context files', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'multiple-files'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    const names = files.map((f) => f.relativePath);
    expect(names).toContain('CLAUDE.md');
    expect(names).toContain('AGENTS.md');
    expect(names).toContain('.cursorrules');
  });

  it('returns empty for directory with no context files', async () => {
    const files = await scanForContextFiles(path.join(FIXTURES, 'healthy-project', 'src'));
    expect(files.length).toBe(0);
  });
});
