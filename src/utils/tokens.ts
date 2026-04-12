// Lazy tiktoken: don't pay the ~5MB WASM cost until countTokens is actually
// called. Earlier versions imported at module top-level, which hoisted the
// import into the CLI's init path and charged every `--version` / `--help`
// invocation. The first countTokens() call pays the one-time load; until
// then the char-based fallback is used (Math.ceil(len/4)).

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
  encoder = loader('gpt-4');
  return encoder;
}

export function countTokens(text: string): number {
  if (!text) return 0;
  const enc = getEncoder();
  if (!enc) {
    return Math.ceil(text.length / 4);
  }
  try {
    return enc.encode(text).length;
  } catch {
    return Math.ceil(text.length / 4);
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

export function forceFreeEncoder(): void {
  _keepAlive = false;
  if (encoder) {
    encoder.free();
    encoder = null;
  }
}
