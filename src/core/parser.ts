import { readFileContent } from '../utils/fs.js';
import { countTokens } from '../utils/tokens.js';
import type { ParsedContextFile, Section, PathReference, CommandReference } from './types.js';
import type { DiscoveredFile } from './scanner.js';

// Match paths with at least one / that look like project file references
// (trailing-slash directory refs like `src/components/` also match via the
// `*` on the final segment; directory refs are routed to the
// `paths/directory-not-found` rule by the consuming check). Middle segments
// allow `*` so glob patterns with double-star segments (`src/**/*.test.ts`,
// spec 2.1's own example) are captured; the consuming check routes anything
// containing `*` to `paths/glob-no-match`.
// Ignore URLs, common false positives.
//
// LIMITATION: forward-slash only. Backslash/Windows-style paths
// (`src\components\foo.ts`) are NOT captured by this pattern -- the segment
// separator is a literal `/`. Only POSIX-shaped path references are detected.
//
// Capture-group note (load-bearing for the column calc at the extract site):
// group 1 is the path itself, deliberately split from the leading delimiter in
// the non-capturing `(?:^|[\s`"'(])` prefix. The column is computed as
// `match.index + match[0].length - match[1].length + 1`, which depends on
// match[1] being the path (without the delimiter). The `/g` flag makes the
// regex stateful across `exec` calls, so callers MUST reset
// `PATH_PATTERN.lastIndex = 0` before scanning each line -- otherwise the first
// match on a line starts mid-line at the previous line's leftover lastIndex and
// the column (and even which matches are found) goes wrong.
const PATH_PATTERN =
  /(?:^|[\s`"'(])((\.{0,2}\/)?(?:[\w@.*-]+\/)+[\w.*-]*(?:\.\w+)?)(?=[\s`"'),;:]|$)/gm;

// False positive patterns to skip
const PATH_EXCLUDE =
  /^(https?:\/\/|ftp:\/\/|mailto:|n\/a|w\/o|I\/O|i\/o|e\.g\.|N\/A|\.deb\/|\.rpm[.\/]|\.tar[.\/]|\.zip[.\/])/i;

// Command patterns. The tool list mirrors spec 2.2's "common command
// patterns to recognize" and the validator's PKG_DEPENDENT_TOOL_PATTERN in
// checks/commands.ts -- a tool listed there but missing here is never
// extracted, so it would silently never be validated.
const COMMAND_PREFIXES = /^\s*[\$>]\s+(.+)$/;
const COMMON_COMMANDS =
  /^(npm|npx|pnpm|yarn|make|cargo|go\s+(run|build|test)|python|pytest|vitest|jest|mocha|tsc|eslint|prettier|bun|deno)\b/;

export function parseContextFile(file: DiscoveredFile): ParsedContextFile {
  const content = readFileContent(file.absolutePath);
  const lines = content.split('\n');
  const sections = parseSections(lines);
  const paths = extractPathReferences(lines, sections);
  const commands = extractCommandReferences(lines, sections);

  return {
    filePath: file.absolutePath,
    relativePath: file.relativePath,
    isSymlink: file.isSymlink,
    symlinkTarget: file.symlinkTarget,
    totalTokens: countTokens(content),
    totalLines: lines.length,
    content,
    sections,
    references: {
      paths,
      commands,
    },
  };
}

function parseSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  // Sections whose endLine is still open: an ancestor chain ordered by
  // strictly increasing heading level, innermost last.
  const openStack: Section[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      const level = match[1].length;
      // Close every open section at the same or a deeper level; SHALLOWER
      // open sections (ancestors) stay open so a parent's range spans its
      // subsections -- per-section token attribution (tier-tokens
      // section-breakdown slices `lines.slice(startLine - 1, endLine)` per
      // top-level section) relies on the parent range including child
      // content. `endLine` is the 1-indexed last content line of the closed
      // section, i.e. the line right before this heading. `i` is 0-indexed
      // here, so the line before the current heading (1-indexed) is `i`,
      // not `i - 1`. (Callers use `lines.slice(startLine - 1, endLine)` --
      // an exclusive-end slice into 0-indexed `lines` -- which lines up
      // with this convention.)
      while (openStack.length > 0) {
        const innermost = openStack[openStack.length - 1];
        if (innermost.level < level) break;
        innermost.endLine = i;
        openStack.pop();
      }
      const section: Section = {
        title: match[2].trim(),
        startLine: i + 1, // 1-indexed
        endLine: -1,
        level,
      };
      sections.push(section);
      openStack.push(section);
    }
  }

  // Close all still-open sections at EOF.
  for (const open of openStack) {
    open.endLine = lines.length;
  }

  return sections;
}

function getSectionForLine(line: number, sections: Section[]): string | undefined {
  for (let i = sections.length - 1; i >= 0; i--) {
    if (line >= sections[i].startLine) {
      return sections[i].title;
    }
  }
  return undefined;
}

function extractPathReferences(lines: string[], sections: Section[]): PathReference[] {
  const paths: PathReference[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code blocks
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim().toLowerCase();
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
      }
      continue;
    }

    // Skip code blocks that look like example code (not file references)
    if (inCodeBlock && isExampleCodeBlock(codeBlockLang)) {
      continue;
    }

    // Extract paths from this line
    PATH_PATTERN.lastIndex = 0;
    let match;
    while ((match = PATH_PATTERN.exec(line)) !== null) {
      const value = match[1];

      // Skip URLs and false positives
      if (PATH_EXCLUDE.test(value)) continue;

      // Skip very short paths that are likely not file references
      if (value.length < 3) continue;

      // Skip version-like patterns (v1.0/2.0)
      if (/^v?\d+\.\d+\//.test(value)) continue;

      // Skip numeric fractions like "10/12" (date, score, ratio)
      if (/^\d+\/\d+$/.test(value)) continue;

      // Skip "Word/Word" prose where both segments look like capitalized tool
      // names and there's no file extension or path hint. E.g. `Biome/Prettier`,
      // `Jest/Vitest` — two Capitalized words joined by a single slash with no
      // extension, no leading ./, ../, or additional path segments.
      if (/^[A-Z][\w.-]*\/[A-Z][\w.-]*$/.test(value) && !value.includes('.')) {
        continue;
      }

      // Strip trailing sentence punctuation that the greedy `[\w.*-]*`
      // accidentally absorbed. "src/foo.ts." at end of a sentence should
      // capture as "src/foo.ts". We only strip if what's left still looks
      // like a path (has a `/`).
      let cleanValue = value;
      while (/[.,;:]$/.test(cleanValue) && cleanValue.includes('/')) {
        cleanValue = cleanValue.slice(0, -1);
      }
      if (!cleanValue.includes('/')) continue;

      // match[0] includes the leading delimiter, match[1] is the captured path
      const column = match.index! + match[0].length - match[1].length + 1;
      paths.push({
        value: cleanValue,
        line: i + 1, // 1-indexed
        column,
        section: getSectionForLine(i + 1, sections),
      });
    }
  }

  return paths;
}

function isExampleCodeBlock(lang: string): boolean {
  // These languages likely contain example code, not file path references
  return [
    'javascript',
    'js',
    'typescript',
    'ts',
    'python',
    'py',
    'go',
    'rust',
    'java',
    'c',
    'cpp',
    'ruby',
    'php',
    'json',
    'yaml',
    'yml',
    'toml',
    'xml',
    'html',
    'css',
    'sql',
    'graphql',
    'jsx',
    'tsx',
  ].includes(lang);
}

function extractCommandReferences(lines: string[], sections: Section[]): CommandReference[] {
  const commands: CommandReference[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim().toLowerCase();
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
      }
      continue;
    }

    // Spec 2.2: command references include content in bash/sh/shell/zsh
    // blocks AND blocks with no language tag (commonly shell snippets). The
    // COMMON_COMMANDS / $-prefix gates below keep non-command lines in bare
    // blocks (sample output, directory trees) from being extracted.
    const isShellBlock = inCodeBlock && ['bash', 'sh', 'shell', 'zsh', ''].includes(codeBlockLang);

    // Check for $ or > prefixed commands (only outside code blocks, or inside shell blocks)
    // Skip markdown blockquotes (lines starting with "> " outside code blocks)
    if (!inCodeBlock || isShellBlock) {
      const prefixMatch = line.match(COMMAND_PREFIXES);
      if (prefixMatch && (inCodeBlock || !line.trimStart().startsWith('>'))) {
        commands.push({
          value: prefixMatch[1].trim(),
          line: i + 1,
          column: prefixMatch.index! + prefixMatch[0].length - prefixMatch[1].length + 1,
          section: getSectionForLine(i + 1, sections),
        });
        continue;
      }
    }

    // In bash/shell code blocks, treat each non-empty line as a command
    if (isShellBlock) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('//')) {
        // Check if it looks like a command
        if (COMMON_COMMANDS.test(trimmed) || trimmed.startsWith('$') || trimmed.startsWith('>')) {
          const cmd = trimmed.replace(/^\s*[\$>]\s*/, '');
          if (cmd) {
            // Find the actual position of the command text in the line
            const cmdStart = line.indexOf(trimmed) + trimmed.indexOf(cmd);
            commands.push({
              value: cmd,
              line: i + 1,
              column: cmdStart + 1,
              section: getSectionForLine(i + 1, sections),
            });
          }
        }
      }
      continue;
    }

    // Inline backtick commands
    const inlineMatches = line.matchAll(/`([^`]+)`/g);
    for (const m of inlineMatches) {
      const cmd = m[1].trim();
      if (COMMON_COMMANDS.test(cmd)) {
        commands.push({
          value: cmd,
          line: i + 1,
          column: (m.index ?? 0) + 2,
          section: getSectionForLine(i + 1, sections),
        });
      }
    }
  }

  return commands;
}
