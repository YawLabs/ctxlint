import { encoding_for_model } from 'tiktoken';

let encoder: ReturnType<typeof encoding_for_model> | null = null;

function getEncoder() {
  if (!encoder) {
    encoder = encoding_for_model('gpt-4');
  }
  return encoder;
}

export function countTokens(text: string): number {
  try {
    const enc = getEncoder();
    const tokens = enc.encode(text);
    return tokens.length;
  } catch {
    // Fallback: rough estimate of ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}

export function freeEncoder(): void {
  if (encoder) {
    encoder.free();
    encoder = null;
  }
}
