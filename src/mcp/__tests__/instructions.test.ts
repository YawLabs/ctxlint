import { describe, it, expect } from 'vitest';
import { INSTRUCTIONS } from '../instructions.js';

describe('MCP instructions', () => {
  it('stays under the 2000-byte ceiling Yaw MCP cuts at', () => {
    // Yaw MCP renders a server's instructions once per namespace per session
    // and truncates them at 2000 bytes (MAX_UPSTREAM_INSTRUCTIONS_BYTES), so
    // anything past that is silently lost.
    expect(Buffer.byteLength(INSTRUCTIONS, 'utf8')).toBeLessThan(2000);
  });

  it('is plain printable ASCII', () => {
    // Sanitizing strips anything else, which would change the text the model
    // sees from the text written here.
    expect(INSTRUCTIONS).toMatch(/^[\x20-\x7e\n]+$/);
  });

  it('names every tool', () => {
    for (const tool of [
      'ctxlint_audit',
      'ctxlint_mcp_audit',
      'ctxlint_session_audit',
      'ctxlint_skill_audit',
      'ctxlint_validate_path',
      'ctxlint_token_report',
      'ctxlint_fix',
    ]) {
      expect(INSTRUCTIONS).toContain(tool);
    }
  });
});
