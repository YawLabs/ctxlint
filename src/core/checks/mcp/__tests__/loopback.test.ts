import { describe, it, expect } from 'vitest';
import { isLoopbackHost } from '../loopback.js';

// Hostnames as WHATWG URL produces them -- the callers pass `new URL(u).hostname`.
const host = (url: string) => new URL(url).hostname;

describe('isLoopbackHost', () => {
  it.each([
    'http://localhost:3000/mcp',
    'http://LOCALHOST/mcp',
    'http://127.0.0.1/mcp',
    'http://127.8.9.10/mcp',
    'http://[::1]/mcp',
    'http://[0:0:0:0:0:0:0:1]/mcp',
  ])('treats %s as loopback', (url) => {
    expect(isLoopbackHost(host(url))).toBe(true);
  });

  it('treats a fully qualified "localhost." as loopback', () => {
    expect(isLoopbackHost(host('http://localhost.:8080/mcp'))).toBe(true);
  });

  it('treats *.localhost subdomains as loopback (RFC 6761 reserves them)', () => {
    expect(isLoopbackHost(host('http://api.localhost/mcp'))).toBe(true);
    expect(isLoopbackHost(host('http://a.b.localhost./mcp'))).toBe(true);
  });

  it('treats IPv4-mapped IPv6 loopback as loopback', () => {
    // WHATWG serializes [::ffff:127.0.0.1] as [::ffff:7f00:1].
    expect(host('http://[::ffff:127.0.0.1]/mcp')).toBe('[::ffff:7f00:1]');
    expect(isLoopbackHost(host('http://[::ffff:127.0.0.1]/mcp'))).toBe(true);
    expect(isLoopbackHost(host('http://[::ffff:127.255.0.9]/mcp'))).toBe(true);
  });

  it('treats the bind-all addresses 0.0.0.0 and [::] as machine-local', () => {
    expect(isLoopbackHost(host('http://0.0.0.0:8080/mcp'))).toBe(true);
    expect(isLoopbackHost(host('http://[::]:8080/mcp'))).toBe(true);
  });

  it.each([
    'http://example.com/mcp',
    'http://localhost.example.com/mcp',
    'http://mylocalhost/mcp',
    'http://128.0.0.1/mcp',
    'http://10.0.0.1/mcp',
    'http://[::2]/mcp',
    'http://[::ffff:10.0.0.1]/mcp',
    'http://[::ffff:8.8.8.8]/mcp',
  ])('treats %s as non-local', (url) => {
    expect(isLoopbackHost(host(url))).toBe(false);
  });
});
