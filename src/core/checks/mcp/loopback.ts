/**
 * Loopback test shared by mcp-security/http-no-tls (loopback is exempt from
 * the TLS requirement) and mcp-urls/localhost-in-project-config (a loopback
 * URL committed to a project config breaks teammates). The two rules must
 * agree on the definition: a host the TLS rule exempts as loopback is exactly
 * the host the project-config rule needs to flag.
 *
 * `URL.hostname` keeps the brackets on IPv6 literals ('[::1]'), so strip them
 * before comparing. WHATWG URL canonicalizes IPv6 ('[0:0:0:0:0:0:0:1]' parses
 * to '[::1]'), so the single '::1' comparison covers the spelled-out forms.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host); // 127.0.0.0/8
}
