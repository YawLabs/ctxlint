/**
 * Machine-local host test shared by mcp-security/http-no-tls (a local target
 * is exempt from the TLS requirement) and mcp-urls/localhost-in-project-config
 * (a machine-local URL committed to a project config breaks teammates). The
 * two rules must agree on the definition: a host the TLS rule exempts as
 * local is exactly the host the project-config rule needs to flag.
 *
 * Covered:
 *  - `localhost`, its fully qualified form `localhost.`, and any
 *    `*.localhost` name (RFC 6761 reserves the whole domain for loopback;
 *    browsers and most resolvers map it to 127.0.0.1 / ::1);
 *  - 127.0.0.0/8 and `::1`, plus IPv4-mapped IPv6 loopback
 *    (`[::ffff:127.0.0.1]`);
 *  - the bind-all addresses `0.0.0.0` and `::`. They are not loopback
 *    strictly, but as a client target they reach a server on the same
 *    machine (or fail, on Windows) -- traffic never leaves the host, so the
 *    TLS rule has nothing to protect, and the URL is just as machine-specific
 *    as `localhost` for the project-config rule.
 *
 * Expects a WHATWG `URL.hostname`: lower-cased, IPv6 in brackets ('[::1]'),
 * IPv6 canonicalized ('[0:0:0:0:0:0:0:1]' parses to '[::1]',
 * '[::ffff:127.0.0.1]' to '[::ffff:7f00:1]'), and IPv4 shorthand normalized
 * ('127.1' parses to '127.0.0.1'), so only canonical forms need matching.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true;
  if (/^127(\.\d{1,3}){3}$/.test(host)) return true; // 127.0.0.0/8
  // IPv4-mapped 127.0.0.0/8: ::ffff:7fXX:XXXX (hex form after canonicalization)
  // or the dotted form, should a caller pass an un-canonicalized host.
  if (/^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host)) return true;
  return /^::ffff:127(\.\d{1,3}){3}$/.test(host);
}
