import { createReadStream, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { countTokens } from '../utils/tokens.js';
import { projectDirCandidates } from './session-parser.js';

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
   * `file-read` -- a path the agent read via Read.
   *
   * A consumer that walks the WHOLE stream rather than filtering to the kinds
   * it wants must decide whether a newly added kind belongs in its walk: an
   * event-count window or a "last branch stamp seen" tracker changes meaning
   * the moment unrelated events are interleaved into it.
   */
  kind: 'command' | 'assistant-text' | 'file-write' | 'file-read';
  /** The command line, the prose, or the written/read path, per `kind`. */
  text: string;
  /** Originating tool name (`Bash`, `PowerShell`, `Write`, `Edit`, `Read`, ...). */
  tool: string;
  /**
   * The `tool_use` id, on tool-originated events. A continued session copies
   * the tail of the one before it into its own file under a new session id,
   * so the same call can appear twice; this is what identifies it as one call.
   */
  toolUseId?: string;
  /**
   * `file-read` only: the Read asked for a slice (`offset`, `limit` or
   * `pages`) rather than the whole file.
   */
  partial?: boolean;
  /** The harness flagged the tool_result as an error. Undefined when unpaired. */
  isError?: boolean;
  /**
   * The tool produced no stdout and no stderr. This is the signature of a
   * runner that died before emitting diagnostics, which is not the same thing
   * as a runner that ran and found nothing. Undefined when unpaired.
   */
  emptyOutput?: boolean;
  /** Length of the tool_result's text, in UTF-16 code units. Undefined when unpaired. */
  outputChars?: number;
  /**
   * `file-read` only: `countTokens` of the result text -- what the Read put
   * into the prompt of every later turn. Undefined when unpaired.
   */
  outputTokens?: number;
  /**
   * `file-read` only: lines in the result, as the harness reported them
   * (`toolUseResult.file.numLines`). Undefined when the record carries none.
   */
  outputLines?: number;
  /** Branch recorded on the record, when the harness stamped one. */
  gitBranch?: string;
  /**
   * 1-based ordinal of the assistant turn this event belongs to, within its
   * session. A turn is one API response; see `turnOf` for how one is counted.
   * Events on records that are not themselves a turn take the session's
   * latest ordinal (0 before its first turn).
   */
  turn: number;
  timestamp: number;
  sessionId: string;
}

/** Tools whose input names a file the agent wrote. */
const WRITE_TOOLS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Tools whose input names a file the agent read. */
const READ_TOOLS: Record<string, string> = {
  Read: 'file_path',
};

/** Read inputs that narrow the call to a slice of the file. */
const PARTIAL_READ_FIELDS = ['offset', 'limit', 'pages'];

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
  /** Assistant turns per session id, counted as `turnOf` counts them. */
  sessionTurns: Map<string, number>;
  /**
   * Per session id, the turn count at each `/compact` boundary, ascending.
   * Sessions that never compacted have no entry.
   */
  sessionCompactions: Map<string, number[]>;
}

function emptyRead(): TranscriptRead {
  return {
    events: [],
    filesRead: 0,
    truncated: false,
    sessionTurns: new Map(),
    sessionCompactions: new Map(),
  };
}

/**
 * Later turns of `ev`'s session that re-send its result as prompt context:
 * every turn after the one that made the call, up to the session's last turn
 * or its next `/compact` boundary, whichever comes first. A compaction
 * replaces the history with a summary, so a result read before one stops
 * riding along at it.
 */
export function turnsCarried(read: TranscriptRead, ev: TranscriptEvent): number {
  const total = read.sessionTurns.get(ev.sessionId) ?? ev.turn;
  const boundary = read.sessionCompactions.get(ev.sessionId)?.find((b) => b >= ev.turn);
  return Math.max(0, (boundary ?? total) - ev.turn);
}

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
 * Memoized per project: several checks consume this and re-streaming tens of
 * megabytes per check would dominate the audit. Long-lived callers (watch
 * mode, the MCP server) clear it between audits.
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

export function readProjectTranscript(
  project: string,
  home = resolveHome(),
): Promise<TranscriptRead> {
  const key = `${home} ${project}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = readUncached(project, home);
    cache.set(key, hit);
  }
  return hit;
}

/**
 * Drop every memoized read. Tests use it so fixture reads do not leak across
 * cases; watch mode and the MCP server use it so a later audit in the same
 * process sees transcripts that grew since the first one.
 */
export function clearTranscriptCache(): void {
  cache.clear();
}

/**
 * Transcript directories that exist for this project. Claude Code has used more
 * than one project-dir encoding (see `projectDirCandidates`), and a session's
 * transcripts can be split across both, so read every form that is present.
 */
function candidateDirs(project: string, home: string): string[] {
  const root = join(home, '.claude', 'projects');
  return projectDirCandidates(project)
    .map((n) => join(root, n))
    .filter((d) => existsSync(d));
}

/** Turn bookkeeping for one session. */
interface SessionTurnState {
  /** Turn key (see `turnOf`) -> 1-based ordinal. Its size is the turn count. */
  ordinals: Map<string, number>;
  /** `ordinals.size` at each compact boundary, in stream order. */
  compactions: number[];
}

interface ReadState {
  events: TranscriptEvent[];
  /**
   * tool_use id -> the event awaiting its result, so `isError` / `emptyOutput`
   * / sizes can be attached when the matching tool_result arrives on a later
   * line.
   */
  pending: Map<string, TranscriptEvent>;
  sessions: Map<string, SessionTurnState>;
  /** Mints a unique turn key for an assistant record that carries no id. */
  anonymous: number;
}

async function readUncached(project: string, home: string): Promise<TranscriptRead> {
  if (!home || !project) return emptyRead();
  const dirs = candidateDirs(project, home);
  if (dirs.length === 0) return emptyRead();

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

  const st: ReadState = { events: [], pending: new Map(), sessions: new Map(), anonymous: 0 };
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
        collect(rec, st);
      }
    } catch {
      // A transcript being appended to by a live session can throw mid-stream
      // (EBUSY/EPERM on Windows). Degrade to what was read rather than losing
      // the whole audit.
    } finally {
      rl.close();
    }
  }

  const sessionTurns = new Map<string, number>();
  const sessionCompactions = new Map<string, number[]>();
  for (const [id, s] of st.sessions) {
    sessionTurns.set(id, s.ordinals.size);
    if (s.compactions.length > 0) {
      sessionCompactions.set(
        id,
        [...s.compactions].sort((a, b) => a - b),
      );
    }
  }

  return {
    events: st.events,
    filesRead: selected.length,
    truncated,
    sessionTurns,
    sessionCompactions,
  };
}

function sessionState(st: ReadState, sessionId: string): SessionTurnState {
  let s = st.sessions.get(sessionId);
  if (!s) {
    s = { ordinals: new Map(), compactions: [] };
    st.sessions.set(sessionId, s);
  }
  return s;
}

/**
 * The 1-based turn ordinal of an assistant record within its session.
 *
 * Claude Code writes one API response as SEVERAL records -- one per content
 * block -- that share a `message.id` (one measured transcript: 1,338 assistant
 * records for 640 distinct ids), so counting records would roughly double the
 * turns. The id is the turn. `requestId` is the fallback, being shared across
 * a response's records the same way; a record with neither is taken as a turn
 * of its own, the only reading that does not invent a merge the transcript
 * never recorded.
 *
 * Not counted, and so given the session's current ordinal instead of a new
 * one: `<synthetic>` records, which the harness writes itself without making a
 * request, and sidechain records, which belong to a subagent's context rather
 * than this session's.
 */
function turnOf(
  rec: Record<string, unknown>,
  message: { id?: unknown; model?: unknown } | undefined,
  st: ReadState,
  sessionId: string,
): number {
  const s = sessionState(st, sessionId);
  if (message?.model === '<synthetic>' || rec.isSidechain === true) return s.ordinals.size;
  // The `#` prefix keeps a minted key apart from real ids, which are
  // underscore-prefixed alphanumerics (`msg_...`).
  const key = asString(message?.id) || asString(rec.requestId) || `#anonymous:${++st.anonymous}`;
  let ordinal = s.ordinals.get(key);
  if (ordinal === undefined) {
    ordinal = s.ordinals.size + 1;
    s.ordinals.set(key, ordinal);
  }
  return ordinal;
}

/** A Read input field that is set, as opposed to absent, null or empty. */
function isSet(v: unknown): boolean {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Line count the harness reports for a Read result. It lives on the enclosing
 * user record (`toolUseResult.file`), not in the tool_result block, so it is
 * matched back by path: a record carrying some other file's result must not
 * lend its count.
 */
function readResultLines(rec: Record<string, unknown>, path: string): number | undefined {
  const result = rec.toolUseResult;
  if (!result || typeof result !== 'object') return undefined;
  const file = (result as { file?: unknown }).file;
  if (!file || typeof file !== 'object') return undefined;
  const { filePath, numLines } = file as { filePath?: unknown; numLines?: unknown };
  if (filePath !== path) return undefined;
  return typeof numLines === 'number' ? numLines : undefined;
}

function collect(rec: Record<string, unknown>, st: ReadState): void {
  const sessionId = asString(rec.sessionId) || asString(rec.session_id);

  // A compaction replaces the session's history with a summary, so results
  // read before it stop being re-sent from here on. Recorded as the turn count
  // so far, which is what `turnsCarried` compares a read's turn against.
  if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
    const s = sessionState(st, sessionId);
    s.compactions.push(s.ordinals.size);
    return;
  }

  const message = rec.message as { content?: unknown; id?: unknown; model?: unknown } | undefined;
  const turn =
    rec.type === 'assistant'
      ? turnOf(rec, message, st, sessionId)
      : (st.sessions.get(sessionId)?.ordinals.size ?? 0);

  const content = message?.content;
  if (!Array.isArray(content)) return;

  const timestamp = Date.parse(asString(rec.timestamp)) || 0;
  const gitBranch = asString(rec.gitBranch) || undefined;

  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    const type = asString(block.type);

    if (type === 'text' && rec.type === 'assistant') {
      const text = asString(block.text);
      if (text) {
        st.events.push({
          kind: 'assistant-text',
          text,
          tool: '',
          gitBranch,
          turn,
          timestamp,
          sessionId,
        });
      }
      continue;
    }

    if (type === 'tool_use') {
      const tool = asString(block.name);
      const input = (block.input ?? {}) as Record<string, unknown>;
      const cmdField = COMMAND_TOOLS[tool];
      const writeField = WRITE_TOOLS[tool];
      const readField = READ_TOOLS[tool];
      let ev: TranscriptEvent | null = null;
      if (cmdField) {
        const text = asString(input[cmdField]);
        if (text) ev = { kind: 'command', text, tool, gitBranch, turn, timestamp, sessionId };
      } else if (writeField) {
        const text = asString(input[writeField]);
        if (text) ev = { kind: 'file-write', text, tool, gitBranch, turn, timestamp, sessionId };
      } else if (readField) {
        const text = asString(input[readField]);
        if (text) {
          ev = {
            kind: 'file-read',
            text,
            tool,
            partial: PARTIAL_READ_FIELDS.some((f) => isSet(input[f])),
            gitBranch,
            turn,
            timestamp,
            sessionId,
          };
        }
      }
      if (ev) {
        const id = asString(block.id);
        if (id) ev.toolUseId = id;
        st.events.push(ev);
        if (id) st.pending.set(id, ev);
      }
      continue;
    }

    if (type === 'tool_result') {
      const id = asString(block.tool_use_id);
      const ev = id ? st.pending.get(id) : undefined;
      if (!ev) continue;
      st.pending.delete(id);
      const out = resultText(block.content);
      ev.isError = block.is_error === true;
      ev.emptyOutput = out.trim().length === 0;
      ev.outputChars = out.length;
      if (ev.kind === 'file-read') {
        // Counted here, while the text is in hand, because the text itself is
        // not kept: this read is memoized, and Read results are the bulk of a
        // transcript's bytes. Every Read is counted, partial ones included --
        // what to do with the count is the consumer's policy, not the reader's.
        ev.outputTokens = countTokens(out);
        const lineCount = readResultLines(rec, ev.text);
        if (lineCount !== undefined) ev.outputLines = lineCount;
      }
    }
  }
}
