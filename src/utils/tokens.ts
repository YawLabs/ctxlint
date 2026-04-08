// Dynamic import so tiktoken (~4MB WASM) is an optional dependency.
// Falls back to a ~4 chars/token estimate when not installed.

interface Encoder {
  encode: (text: string) => ArrayLike<number>;
  free: () => void;
}

let encodingForModel: ((model: string) => Encoder) | null = null;

try {
  const tiktoken = await import('tiktoken');
  encodingForModel = tiktoken.encoding_for_model as unknown as (model: string) => Encoder;
} catch {
  // tiktoken not installed — will use character-based fallback
}

let encoder: Encoder | null = null;

function getEncoder(): Encoder | null {
  if (!encoder && encodingForModel) {
    encoder = encodingForModel('gpt-4');
  }
  return encoder;
}

export function countTokens(text: string): number {
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
let _keepAlive = false;

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
