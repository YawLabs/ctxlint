// Lazy tiktoken: don't pay the ~5MB WASM cost until countTokens is actually
// called. Earlier versions imported at module top-level, which hoisted the
// import into the CLI's init path and charged every `--version` / `--help`
// invocation. The first countTokens() call pays the one-time load; until
// then the charset-aware fallback is used (approximateTokens below).
//
// Accuracy: counts come from cl100k_base (tiktoken's encoding for 'gpt-4'),
// a proxy for Claude's unpublished tokenizer -- expect ~10-20% divergence on
// prose and more on code. Token budgets compared against these counts are
// soft estimates of Claude-loaded context, not exact costs; thresholds
// downstream should carry that tolerance, not treat counts as exact.

import { createRequire } from 'node:module';

interface Encoder {
  encode: (text: string) => ArrayLike<number>;
  free: () => void;
}

type EncodingForModel = (model: string) => Encoder;

let encodingForModel: EncodingForModel | null = null;
let loadAttempted = false;
let encoder: Encoder | null = null;
let _keepAlive = false;

function loadEncodingForModel(): EncodingForModel | null {
  if (loadAttempted) return encodingForModel;
  loadAttempted = true;
  try {
    // Synchronous require so countTokens stays sync. tiktoken ships CJS.
    const req = createRequire(import.meta.url);
    const tiktoken = req('tiktoken') as { encoding_for_model: EncodingForModel };
    encodingForModel = tiktoken.encoding_for_model;
  } catch {
    // tiktoken not installed / not resolvable — stick with char-based fallback
  }
  return encodingForModel;
}

function getEncoder(): Encoder | null {
  if (encoder) return encoder;
  const loader = loadEncodingForModel();
  if (!loader) return null;
  try {
    encoder = loader('gpt-4');
  } catch {
    // Defensive hardening: encoding_for_model has no known throw path once
    // the require succeeded, but if it ever does throw, disable tiktoken for
    // the rest of the process rather than re-running a throwing constructor
    // on every countTokens call.
    encodingForModel = null;
    return null;
  }
  return encoder;
}

// Fallback estimate for when tiktoken is unavailable. ~4 chars per BPE token
// holds for English prose and code, but CJK text encodes at roughly one token
// per codepoint, so a flat length/4 undercounts Japanese/Chinese/Korean text
// 3-4x -- enough for an all-CJK CLAUDE.md to sail under every token budget.
// CJK codepoints count as 1 token each; everything else at 1/4.
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

export function approximateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function countTokens(text: string): number {
  if (!text) return 0;
  const enc = getEncoder();
  if (!enc) {
    return approximateTokens(text);
  }
  try {
    return enc.encode(text).length;
  } catch {
    return approximateTokens(text);
  }
}

export function freeEncoder(): void {
  if (encoder && !_keepAlive) {
    encoder.free();
    encoder = null;
  }
}

// For long-running processes (MCP server): keep the encoder alive to avoid
// re-creating the ~4MB WASM instance on every request.
export function keepEncoderAlive(keep: boolean): void {
  _keepAlive = keep;
}

// Test-only escape hatch: forcibly tears down the encoder regardless of
// _keepAlive so tests can reset module state between runs. No production
// caller — do not remove in a dead-code sweep.
export function forceFreeEncoder(): void {
  _keepAlive = false;
  if (encoder) {
    encoder.free();
    encoder = null;
  }
}
