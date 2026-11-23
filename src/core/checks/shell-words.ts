/**
 * Generic shell-command word splitting shared by the build-tool checks
 * (gradle-projects.ts, maven-modules.ts) and hook-coverage.ts. Nothing here
 * knows about a particular tool.
 *
 * Two splitters, because the callers ask different questions:
 *  - shellWords reads ONE documented command (a build-tool invocation): it
 *    stops at the first control operator or redirection, keeps a `<module>`
 *    doc placeholder in its word, and refuses an unterminated quote.
 *  - hookShellWords reads a WHOLE settings command line for path-shaped words:
 *    a script after `&&` or inside `( ... )` still counts, so operators only
 *    separate words; redirection targets are marked rather than ending the
 *    scan; an unquoted Windows backslash is kept; and an unterminated quote
 *    runs to the end instead of discarding the line.
 */

/** A lone shell line-continuation marker: POSIX `\`, cmd `^`, PowerShell backtick. */
export const CONTINUATION = /^[\\^`]$/;

/**
 * Does the command go on to a line we do not see? Only a TRAILING marker is a
 * continuation: a command reference is one line, and mid-line each of these
 * characters is an escape (`\ ` is a literal space in POSIX sh, `^` and the
 * backtick escape the next character in cmd and PowerShell), not a line break.
 */
export function endsWithContinuation(words: string[]): boolean {
  return words.length > 1 && CONTINUATION.test(words[words.length - 1]);
}

/**
 * Split a command into words, honoring single and double quotes, dropping a
 * trailing `# comment`, and stopping at the first control operator (`&&`,
 * `||`, `|`, `;`) or redirection. Null on an unterminated quote.
 */
export function shellWords(cmd: string): string[] | null {
  const words: string[] = [];
  let buf = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inWord) words.push(buf);
      buf = '';
      inWord = false;
      continue;
    }
    if (!inWord && ch === '#') break;
    // `<module>` in a doc is a placeholder, not an input redirection: keep a
    // `<...>` run that closes before the next space as part of the word.
    if (ch === '<') {
      const close = cmd.slice(i).search(/>|\s/);
      if (close > 1 && cmd[i + close] === '>') {
        buf += cmd.slice(i, i + close + 1);
        i += close;
        inWord = true;
        continue;
      }
    }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '>' || ch === '<') break;
    buf += ch;
    inWord = true;
  }
  if (quote) return null;
  if (inWord) words.push(buf);
  return words;
}

/** `NAME=value` environment assignment preceding a command. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Drop what runs IN FRONT of the real command, so the head check sees the
 * tool: leading `VAR=value` assignments (`JAVA_HOME=/opt/jdk ./gradlew ...`),
 * `env` and `sudo` with their flags (including the value of one that takes
 * one, `sudo -u user`), and an `sh` / `bash` that runs a script file
 * (`sh gradlew :a:test`). `sh -c '...'` is left alone: the quoted string is a
 * whole script, not a command whose words we can read, so the head check fails
 * and the command is not treated as a build-tool invocation.
 */
export function stripCommandPrefix(words: string[]): string[] {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return [];
    if (ENV_ASSIGNMENT.test(w)) {
      i++;
      continue;
    }
    if (w === 'env' || w === 'sudo') {
      i++;
      while (words[i] !== undefined && words[i].startsWith('-')) {
        // `sudo -u user`, `sudo -g group`, `env -u NAME` consume a value.
        if (/^-[ugCDhpRrTU]$/.test(words[i])) i++;
        i++;
      }
      continue;
    }
    if (
      (w === 'sh' || w === 'bash') &&
      words[i + 1] !== undefined &&
      !words[i + 1].startsWith('-')
    ) {
      i++;
      continue;
    }
    return words.slice(i);
  }
}

/** One shell word, with quotes removed and adjacent pieces joined. */
export interface ShellWord {
  text: string;
  /** True when the word is the target of a `<` / `>` redirection. */
  redirectTarget: boolean;
  /**
   * True when the word is in command position: the first word of the line or
   * of a command after `;` `&&` `|` `(`, or the word after a leading
   * `VAR=value` assignment there. That word is what the shell executes.
   */
  commandStart: boolean;
}

/** Characters that end a word and are not part of any word. */
const HOOK_SHELL_OPERATOR = /[;&|()]/;

/**
 * Split a whole hook / permission command line (hook-coverage.ts) into shell
 * words the way POSIX sh does for the parts that matter there: quotes are
 * removed and ADJACENT quoted/unquoted pieces join into one word, so
 * `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh` is one word, not
 * `$CLAUDE_PROJECT_DIR` plus a bogus absolute `/.claude/hooks/x.sh` (the form
 * Claude Code's own hook docs recommend, which hook-coverage/dead-hook used to
 * report as dead). Operators (`;`, `&&`, `|`, parens) separate words; the word
 * after `<`/`>` is marked as a redirection target, so `2>&1` and `> out.log`
 * are not read as script paths.
 *
 * One deliberate departure: an unquoted backslash escapes only shell-special
 * characters. Windows-authored commands write `C:\hooks\gate.ps1` unquoted,
 * and sh's "backslash escapes anything" would mangle it into `C:hooksgate.ps1`.
 * For the same reason a `\\` that STARTS a word (bare or just inside an opening
 * double quote) and is followed by an ordinary character is a UNC prefix
 * (`\\host\share\gate.ps1`) and is kept whole;
 * collapsing it to `\host\...` resolved to the current drive's root and
 * reported a live hook as dead.
 */
export function hookShellWords(command: string): ShellWord[] {
  const out: ShellWord[] = [];
  let buf = '';
  let inWord = false;
  let redirect = false;
  // The next non-redirect word is in command position.
  let atCommand = true;
  const flush = () => {
    if (inWord) {
      const commandStart = atCommand && !redirect;
      out.push({ text: buf, redirectTarget: redirect, commandStart });
      // A leading `VAR=value` keeps the command position for the next word.
      if (!redirect) atCommand = commandStart && /^[A-Za-z_][A-Za-z0-9_]*=/.test(buf);
      redirect = false;
    }
    buf = '';
    inWord = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (
      ch === '\\' &&
      !inWord &&
      command[i + 1] === '\\' &&
      /[^\s"'\\$`;&|<>()*?]/.test(command[i + 2] ?? '')
    ) {
      buf += '\\\\';
      inWord = true;
      i++;
      continue;
    }
    if (ch === "'") {
      const end = command.indexOf("'", i + 1);
      const stop = end < 0 ? command.length : end;
      buf += command.slice(i + 1, stop);
      inWord = true;
      i = stop;
      continue;
    }
    if (ch === '"') {
      // The UNC exemption above applies to a quoted path too
      // (`"\\host\share\my gate.ps1"`, the usual form when it has spaces).
      const wordStart = !inWord;
      inWord = true;
      i++;
      if (
        wordStart &&
        command[i] === '\\' &&
        command[i + 1] === '\\' &&
        /[^\s"'\\$`;&|<>()*?]/.test(command[i + 2] ?? '')
      ) {
        buf += '\\\\';
        i += 2;
      }
      while (i < command.length && command[i] !== '"') {
        if (command[i] === '\\' && /["\\$`]/.test(command[i + 1] ?? '')) i++;
        buf += command[i];
        i++;
      }
      continue;
    }
    if (ch === '\\' && i + 1 < command.length && /[\s"'\\$`;&|<>()*?]/.test(command[i + 1])) {
      buf += command[++i];
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (ch === '<' || ch === '>') {
      // `2>` / `&>`: a bare fd number before the operator is not a word.
      if (inWord && /^\d+$/.test(buf)) {
        buf = '';
        inWord = false;
      }
      flush();
      redirect = true;
      continue;
    }
    if (HOOK_SHELL_OPERATOR.test(ch)) {
      flush();
      // `>&1` keeps the redirect pending for the fd word that follows.
      if (ch === '&' && redirect) continue;
      redirect = false;
      // `)` closes a subshell; the word after it is not a new command.
      if (ch !== ')') atCommand = true;
      continue;
    }
    buf += ch;
    inWord = true;
  }
  flush();
  return out;
}
