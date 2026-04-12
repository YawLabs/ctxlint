import { readFileContent } from '../utils/fs.js';
import { countTokens } from '../utils/tokens.js';
import type { ParsedContextFile, Section, PathReference, CommandReference } from './types.js';
import type { DiscoveredFile } from './scanner.js';

// Match paths with at least one / that look like project file references
// Ignore URLs, common false positives
const PATH_PATTERN =
  /(?:^|[\s`"'(])((\.{0,2}\/)?(?:[\w@.-]+\/)+[\w.*-]+(?:\.\w+)?)(?=[\s`"'),;:]|$)/gm;

// False positive patterns to skip
const PATH_EXCLUDE =
  /^(https?:\/\/|ftp:\/\/|mailto:|n\/a|w\/o|I\/O|i\/o|e\.g\.|N\/A|\.deb\/|\.rpm[.\/]|\.tar[.\/]|\.zip[.\/])/i;

// Command patterns
const COMMAND_PREFIXES = /^\s*[\$>]\s+(.+)$/;
const COMMON_COMMANDS =
  /^(npm|npx|pnpm|yarn|make|cargo|go\s+(run|build|test)|python|pytest|vitest|jest|bun|deno)\b/;

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

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(#{1,6})\s+(.+)/);
    if (match) {
      // Close previous section at same or higher level
      if (sections.length > 0) {
        const prev = sections[sections.length - 1];
        if (prev.endLine === -1) {
          prev.endLine = i - 1;
        }
      }
      sections.push({
        title: match[2].trim(),
        startLine: i + 1, // 1-indexed
        endLine: -1,
        level: match[1].length,
      });
    }
  }

  // Close last section
  if (sections.length > 0) {
    const last = sections[sections.length - 1];
    if (last.endLine === -1) {
      last.endLine = lines.length;
    }
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

      // match[0] includes the leading delimiter, match[1] is the captured path
      const column = match.index! + match[0].length - match[1].length + 1;
      paths.push({
        value,
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

    const isShellBlock = inCodeBlock && ['bash', 'sh', 'shell', 'zsh'].includes(codeBlockLang);

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
