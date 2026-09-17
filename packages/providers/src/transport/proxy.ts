/**
 * Which proxy, if any, a request should go through.
 *
 * Corporate networks reach the internet only through a proxy, and they
 * advertise it the same way every other tool expects: `HTTPS_PROXY` and
 * friends. Ignoring them means a user whose whole machine is already
 * configured still has to find and fill in a proxy field, and until they do
 * every call fails by timing out — which reads as "the provider is down"
 * rather than "this request never left the network".
 *
 * An explicitly configured proxy always wins, so the environment is a
 * fallback rather than an override.
 */

/** Hosts that are never proxied, whatever the environment says. */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host === '::1' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host)
  );
}

/**
 * Reads `NO_PROXY`, which lists hosts to reach directly.
 *
 * Entries match a host exactly or as a domain suffix; `*` disables proxying
 * altogether. This is the de facto format, not a standard, so it is kept
 * deliberately simple.
 */
function isExempt(hostname: string, noProxy: string): boolean {
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase().replace(/^\*?\./, '');
    if (!entry) continue;
    if (entry === '*') return true;
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * Resolves the proxy for one request.
 *
 * @param targetUrl Absolute URL the request is for.
 * @param explicit Proxy from configuration, which takes precedence.
 */
export function resolveProxy(
  targetUrl: string,
  explicit?: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (explicit) return explicit;

  let target: URL;
  try {
    target = new URL(targetUrl);
  } catch {
    return undefined;
  }

  // A local server needs no proxy, and sending loopback traffic to one would
  // break every local setup on a machine that has a proxy configured.
  if (isLoopback(target.hostname)) return undefined;

  const noProxy = env['NO_PROXY'] ?? env['no_proxy'] ?? '';
  if (noProxy && isExempt(target.hostname, noProxy)) return undefined;

  const candidates =
    target.protocol === 'https:'
      ? [env['HTTPS_PROXY'], env['https_proxy'], env['ALL_PROXY'], env['all_proxy']]
      : [env['HTTP_PROXY'], env['http_proxy'], env['ALL_PROXY'], env['all_proxy']];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return undefined;
}
