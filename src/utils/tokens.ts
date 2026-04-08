// Dynamic import so tiktoken (~4MB WASM) is an optional dependency.
// Falls back to a ~4 chars/token estimate when not installed.
let encodingForModel:
  | ((model: string) => { encode: (text: string) => number[]; free: () => void })
  | null = null;

try {
  const tiktoken = await import('tiktoken');
  encodingForModel = tiktoken.encoding_for_model;
} catch {
  // tiktoken not installed — will use character-based fallback
}

let encoder: ReturnType<NonNullable<typeof encodingForModel>> | null = null;

function getEncoder() {
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
  if (encoder) {
    encoder.free();
    encoder = null;
  }
}
