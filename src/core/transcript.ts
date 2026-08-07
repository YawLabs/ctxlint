import { createReadStream, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { encodeProjectDir } from './session-parser.js';

/**
 * Reader for Claude Code session TRANSCRIPTS, as distinct from `history.jsonl`.
 *
 * Why this exists: `history.jsonl` records only what the USER typed. It carries
 * no tool invocations, no command output and no git state, so a session check
 * built on it can only ever see prompts. Every hazard that lives in what the
 * AGENT did -- the command it ran, the gate that crashed, the branch the edits
 * landed on -- is invisible from there.
 *
 * The transcripts under `~/.claude/projects/<encoded>/<uuid>.jsonl` do carry all
 * of it: `tool_use` blocks with their inputs, the matching `tool_result` with
 * `is_error` and output, and a `gitBranch` stamp on every assistant record.
 *
 * Scope is deliberately ONE project. The transcript corpus on a working machine
 * runs to hundreds of megabytes across a hundred-plus project directories, so a
 * global sweep is not viable per audit -- and it is not wanted either. These
 * checks ask "what happened in THIS repo", which is the same scoping
 * `session/memory-index-overflow` already uses to find its MEMORY.md.
 */

export interface TranscriptEvent {
  /**
   * `command` -- a shell command the agent ran.
   * `assistant-text` -- prose the agent emitted to the user.
   * `file-write` -- a path the agent wrote via Write/Edit/NotebookEdit.
   */
  kind: 'command' | 'assistant-text' | 'file-write';
  /** The command line, the prose, or the written path, per `kind`. */
  text: string;
  /** Originating tool name (`Bash`, `PowerShell`, `Write`, `Edit`, ...). */
  tool: string;
  /** The harness flagged the tool_result as an error. Undefined when unpaired. */
  isError?: boolean;
  /**
   * The tool produced no stdout and no stderr. This is the signature of a
   * runner that died before emitting diagnostics, which is not the same thing
   * as a runner that ran and found nothing. Undefined when unpaired.
   */
  emptyOutput?: boolean;
  /** Branch recorded on the record, when the harness stamped one. */
  gitBranch?: string;
  timestamp: number;
  sessionId: string;
}

/** Tools whose input names a file the agent wrote. */
const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Tools that run a shell command. */
const COMMAND_TOOLS: Record<string, string> = {
  Bash: 'command',
  PowerShell: 'command',
};

/**
 * Bounds. A single transcript reaches tens of megabytes, and a long-lived repo
 * accumulates many. Both caps are surfaced on the result rather than applied
 * silently -- a check that reports "clean" off a truncated read would be
 * asserting something it did not look at.
 */
const MAX_TRANSCRIPTS = 5;
const MAX_LINES = 200000;

export interface TranscriptRead {
  events: TranscriptEvent[];
  /** Transcript files actually read. */
  filesRead: number;
  /** True when a cap stopped the read short of the full corpus. */
  truncated: boolean;
}

const EMPTY: TranscriptRead = { events: [], filesRead: 0, truncated: false };

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Flatten a tool_result's `content` to text. The harness writes either a bare
 * string or an array of typed blocks depending on the tool.
 */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => (b && typeof b === 'object' ? asString((b as { text?: unknown }).text) : ''))
    .join('');
}

/**
 * Memoized per project for the life of the process: several checks consume this
 * and re-streaming tens of megabytes per check would dominate the audit.
 */
const cache = new Map<string, Promise<TranscriptRead>>();

/**
 * Env-first so tests and sandboxes can redirect home, OS fallback so a shell
 * with neither HOME nor USERPROFILE still resolves. Mirrors the resolution
 * `session/memory-index-overflow` uses to find MEMORY.md.
 */
function resolveHome(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}

export function readProjectTranscript(project: string, home = resolveHome()): Promise<TranscriptRead> {
  const key = `${home} ${project}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = readUncached(project, home);
    cache.set(key, hit);
  }
  return hit;
}

/** Test seam -- the memo would otherwise leak fixture reads across cases. */
export function clearTranscriptCache(): void {
  cache.clear();
}

/**
 * Project directories Claude Code may have used for this path.
 *
 * `encodeProjectDir` maps `: \ / .` to `-` but leaves `_` intact. Claude Code's
 * own encoding ALSO folds `_`, and both forms are present on a machine with any
 * history -- `C--Users-x-yaw-mcp_servers-npmjs-mcp` and
 * `C--Users-x-yaw-mcp-servers-npmjs-mcp` both exist, so the scheme changed at
 * some version rather than one form simply being wrong.
 *
 * So try both and read whichever exist. Fixing `encodeProjectDir` itself is NOT
 * the move: it is documented as deliberately parity-matched to Claude Code's
 * layout, and several other checks match on its exact output, so changing it
 * would strand every project still using the underscore-preserving form.
 */
function candidateDirs(project: string, home: string): string[] {
  const root = join(home, '.claude', 'projects');
  const encoded = encodeProjectDir(project);
  const folded = encoded.replace(/_/g, '-');
  const names = folded === encoded ? [encoded] : [encoded, folded];
  return names.map((n) => join(root, n)).filter((d) => existsSync(d));
}

async function readUncached(project: string, home: string): Promise<TranscriptRead> {
  if (!home || !project) return EMPTY;
  const dirs = candidateDirs(project, home);
  if (dirs.length === 0) return EMPTY;

  const names: Array<{ dir: string; name: string }> = [];
  for (const dir of dirs) {
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      names.push({ dir, name });
    }
  }
  const files = names
    .filter(({ name }) => name.endsWith('.jsonl'))
    .map(({ dir, name }) => {
      const p = join(dir, name);
      try {
        return { p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is { p: string; mtime: number } => f !== null)
    // Most recent first: when the cap bites, the sessions dropped should be the
    // oldest ones, not whichever the directory listing happened to yield last.
    .sort((a, b) => b.mtime - a.mtime);

  let truncated = files.length > MAX_TRANSCRIPTS;
  const selected = files.slice(0, MAX_TRANSCRIPTS);

  const events: TranscriptEvent[] = [];
  // tool_use id -> the event awaiting its result, so `isError` / `emptyOutput`
  // can be attached when the matching tool_result arrives on a later line.
  const pending = new Map<string, TranscriptEvent>();
  let lines = 0;

  for (const { p } of selected) {
    if (lines >= MAX_LINES) {
      truncated = true;
      break;
    }
    const rl = createInterface({
      input: createReadStream(p, { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    try {
      for await (const raw of rl) {
        if (++lines >= MAX_LINES) {
          truncated = true;
          break;
        }
        const line = raw.trim();
        if (!line) continue;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        collect(rec, events, pending);
      }
    } catch {
      // A transcript being appended to by a live session can throw mid-stream
      // (EBUSY/EPERM on Windows). Degrade to what was read rather than losing
      // the whole audit.
    } finally {
      rl.close();
    }
  }

  return { events, filesRead: selected.length, truncated };
}

function collect(
  rec: Record<string, unknown>,
  events: TranscriptEvent[],
  pending: Map<string, TranscriptEvent>,
): void {
  const message = rec.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return;

  const timestamp = Date.parse(asString(rec.timestamp)) || 0;
  const sessionId = asString(rec.sessionId) || asString(rec.session_id);
  const gitBranch = asString(rec.gitBranch) || undefined;

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    const type = asString(block.type);

    if (type === 'text' && rec.type === 'assistant') {
      const text = asString(block.text);
      if (text) {
        events.push({ kind: 'assistant-text', text, tool: '', gitBranch, timestamp, sessionId });
      }
      continue;
    }

    if (type === 'tool_use') {
      const tool = asString(block.name);
      const input = (block.input ?? {}) as Record<string, unknown>;
      const cmdField = COMMAND_TOOLS[tool];
      const writeField = WRITE_TOOLS[tool];
      let ev: TranscriptEvent | null = null;
      if (cmdField) {
        const text = asString(input[cmdField]);
        if (text) ev = { kind: 'command', text, tool, gitBranch, timestamp, sessionId };
      } else if (writeField) {
        const text = asString(input[writeField]);
        if (text) ev = { kind: 'file-write', text, tool, gitBranch, timestamp, sessionId };
      }
      if (ev) {
        events.push(ev);
        const id = asString(block.id);
        if (id) pending.set(id, ev);
      }
      continue;
    }

    if (type === 'tool_result') {
      const id = asString(block.tool_use_id);
      const ev = id ? pending.get(id) : undefined;
      if (!ev) continue;
      pending.delete(id);
      ev.isError = block.is_error === true;
      ev.emptyOutput = resultText(block.content).trim().length === 0;
    }
  }
}
