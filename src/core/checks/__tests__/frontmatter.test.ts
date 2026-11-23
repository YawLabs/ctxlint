import { describe, it, expect } from 'vitest';
import { checkFrontmatter } from '../frontmatter.js';
import type { ParsedContextFile } from '../../types.js';

function makeFile(relativePath: string, content: string): ParsedContextFile {
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

describe('checkFrontmatter', () => {
  describe('Cursor .mdc files', () => {
    it('warns when .mdc file has no frontmatter', async () => {
      const file = makeFile('.cursor/rules/test.mdc', 'No frontmatter here.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].message).toContain('missing frontmatter');
    });

    it('warns when missing description field', async () => {
      const file = makeFile('.cursor/rules/test.mdc', '---\nalwaysApply: true\n---\nSome content.');
      const issues = await checkFrontmatter(file, '/project');
      const descIssue = issues.find((i) => i.message.includes('description'));
      expect(descIssue).toBeDefined();
    });

    it('errors on invalid alwaysApply value', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: test\nalwaysApply: maybe\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const invalidIssue = issues.find((i) => i.severity === 'error');
      expect(invalidIssue).toBeDefined();
      expect(invalidIssue!.message).toContain('alwaysApply');
    });

    it('passes for valid .mdc frontmatter', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: ["src/**/*.ts"]\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(0);
    });

    it('accepts a bare directory name in globs (no slash, no star)', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: src\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeUndefined();
    });

    it('accepts a glob pattern with slash and star in globs', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: src/**/*.ts\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeUndefined();
    });

    it('accepts a bare extension in globs', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: ts\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeUndefined();
    });

    it('flags globs with unmatched brackets', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: ["src/**/*.ts"\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeDefined();
      expect(globsIssue!.message).toContain('malformed');
    });

    it('accepts a globs value with a literal mid-value apostrophe', async () => {
      // A lone apostrophe inside the path (not at the start) is literal, not
      // YAML quoting — must not trip the odd-quote-count branch.
      const file = makeFile(
        '.cursor/rules/test.mdc',
        "---\ndescription: My rule\nglobs: src/don't/**\nalwaysApply: false\n---\nContent.",
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeUndefined();
    });

    it('flags globs with unmatched quotes', async () => {
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nglobs: "src/**/*.ts\nalwaysApply: false\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const globsIssue = issues.find((i) => i.message.toLowerCase().includes('globs'));
      expect(globsIssue).toBeDefined();
    });
  });

  describe('Copilot instructions', () => {
    it('warns when missing applyTo field', async () => {
      const file = makeFile(
        '.github/instructions/test.instructions.md',
        '---\ndescription: test\n---\nContent.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const applyToIssue = issues.find((i) => i.message.includes('applyTo'));
      expect(applyToIssue).toBeDefined();
    });

    it('info when no frontmatter at all', async () => {
      const file = makeFile(
        '.github/instructions/test.instructions.md',
        'Just content, no frontmatter.',
      );
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0].severity).toBe('info');
    });
  });

  describe('Windsurf rules', () => {
    it('errors on invalid trigger value', async () => {
      const file = makeFile('.windsurf/rules/test.md', '---\ntrigger: sometimes\n---\nContent.');
      const issues = await checkFrontmatter(file, '/project');
      const triggerIssue = issues.find((i) => i.severity === 'error');
      expect(triggerIssue).toBeDefined();
      expect(triggerIssue!.message).toContain('trigger');
    });

    it('passes for valid trigger', async () => {
      const file = makeFile('.windsurf/rules/test.md', '---\ntrigger: always_on\n---\nContent.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(0);
    });

    it('warns when missing trigger field', async () => {
      const file = makeFile('.windsurf/rules/test.md', '---\nname: test\n---\nContent.');
      const issues = await checkFrontmatter(file, '/project');
      const triggerIssue = issues.find((i) => i.message.includes('trigger'));
      expect(triggerIssue).toBeDefined();
    });
  });

  describe('non-frontmatter files', () => {
    it('skips files that do not require frontmatter', async () => {
      const file = makeFile('CLAUDE.md', '# Project\nSome content.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(0);
    });
  });

  describe('unclosed frontmatter', () => {
    it('errors on unclosed .mdc frontmatter (no other frontmatter findings)', async () => {
      // Opening fence present, no closing fence — host treats the file as
      // having no frontmatter at all, so we don't want to also emit
      // "missing description" / "no activation" findings on top of the
      // primary diagnosis.
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nalwaysApply: true\n\nBody text without close.\n',
      );
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(1);
      expect(issues[0].severity).toBe('error');
      expect(issues[0].ruleId).toBe('frontmatter/unclosed');
    });

    it('errors on unclosed Copilot instructions frontmatter', async () => {
      const file = makeFile(
        '.github/instructions/test.instructions.md',
        '---\napplyTo: "**/*.ts"\n\nBody.',
      );
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(1);
      expect(issues[0].ruleId).toBe('frontmatter/unclosed');
    });

    it('errors on unclosed Windsurf rule frontmatter', async () => {
      const file = makeFile('.windsurf/rules/test.md', '---\ntrigger: always_on\n\nBody.');
      const issues = await checkFrontmatter(file, '/project');
      expect(issues.length).toBe(1);
      expect(issues[0].ruleId).toBe('frontmatter/unclosed');
    });

    it('treats an INDENTED close fence as unclosed (host requires column 0)', async () => {
      // gray-matter / Cursor only recognize a closing `---` at column 0. An
      // indented `   ---` does not close the frontmatter, so the whole body is
      // pulled into the YAML parse and the rule silently fails to apply — we
      // must report frontmatter/unclosed, matching the suggestion text that
      // says the close needs no leading whitespace.
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: My rule\nalwaysApply: true\n   ---\nBody.',
      );
      const issues = await checkFrontmatter(file, '/project');
      expect(issues).toHaveLength(1);
      expect(issues[0].ruleId).toBe('frontmatter/unclosed');
    });

    it('still treats a properly closed frontmatter as found', async () => {
      // Sanity: the unclosed signal must not fire when the close fence is
      // present, even if other validation issues exist.
      const file = makeFile(
        '.cursor/rules/test.mdc',
        '---\ndescription: ok\nalwaysApply: maybe\n---\nBody.',
      );
      const issues = await checkFrontmatter(file, '/project');
      const unclosed = issues.find((i) => i.ruleId === 'frontmatter/unclosed');
      expect(unclosed).toBeUndefined();
      const invalid = issues.find((i) => i.ruleId === 'frontmatter/invalid-value');
      expect(invalid).toBeDefined();
    });
  });
});

describe('checkFrontmatter -- CRLF line endings', () => {
  // Windows checkouts with core.autocrlf=true hand the check CRLF content
  // (readFileContent only strips the BOM). Each case is the byte-for-byte CRLF
  // twin of an LF input and must produce identical issues.
  const crlf = (s: string) => s.replace(/\n/g, '\r\n');

  async function both(relativePath: string, lf: string) {
    const lfIssues = await checkFrontmatter(makeFile(relativePath, lf), '/project');
    const crlfIssues = await checkFrontmatter(makeFile(relativePath, crlf(lf)), '/project');
    return { lfIssues, crlfIssues };
  }

  it('does not report a CRLF-closed .mdc frontmatter as unclosed', async () => {
    const { lfIssues, crlfIssues } = await both(
      '.cursor/rules/test.mdc',
      '---\ndescription: My rule\nglobs: src/**/*.ts\nalwaysApply: false\n---\nBody',
    );
    expect(lfIssues).toEqual([]);
    expect(crlfIssues).toEqual(lfIssues);
  });

  it('parses CRLF field values without a trailing carriage return', async () => {
    const { lfIssues, crlfIssues } = await both(
      '.cursor/rules/test.mdc',
      '---\ndescription: ok\nalwaysApply: maybe\n---\nBody.',
    );
    expect(lfIssues.map((i) => i.ruleId)).toEqual(['frontmatter/invalid-value']);
    expect(crlfIssues).toEqual(lfIssues);
    expect(crlfIssues[0].message).not.toContain('\r');
  });

  it('accepts CRLF Windsurf and Copilot frontmatter identically to LF', async () => {
    const ws = await both('.windsurf/rules/r.md', '---\ntrigger: manual\n---\nBody');
    expect(ws.lfIssues).toEqual([]);
    expect(ws.crlfIssues).toEqual(ws.lfIssues);
    const gh = await both(
      '.github/instructions/a.instructions.md',
      '---\napplyTo: "**/*.ts"\n---\nBody',
    );
    expect(gh.lfIssues).toEqual([]);
    expect(gh.crlfIssues).toEqual(gh.lfIssues);
  });

  it('accepts a closing fence with trailing whitespace', async () => {
    const file = makeFile(
      '.cursor/rules/test.mdc',
      '---\ndescription: My rule\nalwaysApply: true\n--- \nBody.',
    );
    const issues = await checkFrontmatter(file, '/project');
    expect(issues).toEqual([]);
  });
});

describe('checkFrontmatter -- YAML value forms', () => {
  const mdc = (fm: string) => makeFile('.cursor/rules/test.mdc', `---\n${fm}\n---\nBody.`);
  const windsurf = (fm: string) => makeFile('.windsurf/rules/test.md', `---\n${fm}\n---\nBody.`);

  it('ignores a trailing # comment on alwaysApply', async () => {
    const issues = await checkFrontmatter(
      mdc('description: My rule\nalwaysApply: true # always on'),
      '/project',
    );
    expect(issues).toEqual([]);
  });

  it('accepts a quoted alwaysApply value', async () => {
    const issues = await checkFrontmatter(
      mdc('description: My rule\nalwaysApply: "true"'),
      '/project',
    );
    expect(issues).toEqual([]);
  });

  it('keeps a # that is inside quotes or not preceded by whitespace', async () => {
    // `"a #b"` is a quoted scalar, `x#y` a plain scalar containing `#`.
    const issues = await checkFrontmatter(
      mdc('description: "Rule #1 for src"\nglobs: src/x#y/**\nalwaysApply: false'),
      '/project',
    );
    expect(issues).toEqual([]);
  });

  it('ignores a trailing # comment on a Windsurf trigger', async () => {
    const issues = await checkFrontmatter(windsurf('trigger: glob # note'), '/project');
    expect(issues).toEqual([]);
  });

  it('joins a multi-line flow sequence for globs', async () => {
    const issues = await checkFrontmatter(
      mdc(
        'description: My rule\nglobs: [\n  "src/**/*.ts",\n  "src/**/*.tsx"\n]\nalwaysApply: false',
      ),
      '/project',
    );
    expect(issues).toEqual([]);
  });

  it('still flags a flow sequence that is never closed', async () => {
    const issues = await checkFrontmatter(
      mdc('description: My rule\nglobs: [\n  "src/**/*.ts",\nalwaysApply: false'),
      '/project',
    );
    expect(issues.map((i) => i.ruleId)).toEqual(['frontmatter/invalid-value']);
  });

  it('reads a description written on the next indented line', async () => {
    const issues = await checkFrontmatter(
      mdc('description:\n  Applies to the TypeScript sources\nalwaysApply: true'),
      '/project',
    );
    expect(issues).toEqual([]);
  });

  it('reads a folded block-scalar description', async () => {
    const issues = await checkFrontmatter(
      mdc('description: >-\n  Applies to the\n  TypeScript sources\nalwaysApply: true'),
      '/project',
    );
    expect(issues).toEqual([]);
  });

  it('folds an indented key-shaped line into a block-scalar description', async () => {
    const issues = await checkFrontmatter(
      mdc('description: >-\n  Note: applies to the\n  TypeScript sources\nalwaysApply: true'),
      '/project',
    );
    expect(issues).toEqual([]);
  });

  it('folds an indented key-shaped line into an empty-value description', async () => {
    const issues = await checkFrontmatter(
      mdc('description:\n  Note: applies to the TypeScript sources\nalwaysApply: true'),
      '/project',
    );
    expect(issues).toEqual([]);
  });

  it('ends the block scalar when indentation returns to the key column', async () => {
    // alwaysApply at column 0 is a key again (its bad value is still
    // validated) and description keeps the folded `Note: x` text.
    const issues = await checkFrontmatter(
      mdc('description: |\n  Note: x\nalwaysApply: maybe'),
      '/project',
    );
    expect(issues.map((i) => i.ruleId)).toEqual(['frontmatter/invalid-value']);
  });

  it('still reports an empty block-scalar description', async () => {
    const issues = await checkFrontmatter(mdc('description: >-\nalwaysApply: true'), '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['frontmatter/missing-field']);
  });

  it('still reports an empty description', async () => {
    const issues = await checkFrontmatter(mdc('description:\nalwaysApply: true'), '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['frontmatter/missing-field']);
  });

  it('still reads YAML list items for globs', async () => {
    const issues = await checkFrontmatter(
      mdc('description: d\nglobs:\n  - "src/**" # sources\n  - tests/**\nalwaysApply: false'),
      '/project',
    );
    expect(issues).toEqual([]);
  });
});

describe('checkFrontmatter -- file matching and Windsurf triggers', () => {
  it('only treats *.instructions.md under .github/instructions/ as Copilot instructions', async () => {
    const readme = makeFile('.github/instructions/README.md', 'How these files work.');
    expect(await checkFrontmatter(readme, '/project')).toEqual([]);
    const real = makeFile('.github/instructions/ts.instructions.md', 'No frontmatter.');
    expect((await checkFrontmatter(real, '/project')).map((i) => i.ruleId)).toEqual([
      'frontmatter/missing',
    ]);
  });

  it('rejects trigger: model, which is not a documented Windsurf trigger', async () => {
    const file = makeFile('.windsurf/rules/test.md', '---\ntrigger: model\n---\nBody.');
    const issues = await checkFrontmatter(file, '/project');
    expect(issues.map((i) => i.ruleId)).toEqual(['frontmatter/invalid-value']);
  });

  it('accepts trigger: model_decision', async () => {
    const file = makeFile('.windsurf/rules/test.md', '---\ntrigger: model_decision\n---\nBody.');
    expect(await checkFrontmatter(file, '/project')).toEqual([]);
  });
});
