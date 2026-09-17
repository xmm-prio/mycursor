/**
 * Normalising Node's many request-argument shapes into one descriptor.
 *
 * `http.request` accepts a URL string, a `URL`, an options object, or a URL
 * plus an options object, and `http.get` adds its own variants on top. Every
 * layer needs the same three facts — host, port, path — so the parsing lives
 * here once instead of being re-derived per layer.
 */

export type RequestArgShape = 'string' | 'url' | 'options';

export interface RequestTarget {
  hostname: string;
  /** Explicit port, or null when the protocol default applies. */
  port: number | null;
  protocol: string;
  /** Path including query string. */
  path: string;
  shape: RequestArgShape;
}

export interface ParsedRequestArgs {
  target: RequestTarget;
  /** Merged options object ready to hand to `http.request`. */
  options: Record<string, unknown>;
  callback: ((...args: unknown[]) => void) | undefined;
}

function splitHostHeader(value: string): { host: string; port: number | null } {
  // IPv6 literals are bracketed, so only split on the last colon of a name.
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close === -1) return { host: value, port: null };
    const rest = value.slice(close + 1);
    const port = rest.startsWith(':') ? Number.parseInt(rest.slice(1), 10) : NaN;
    return { host: value.slice(1, close), port: Number.isInteger(port) ? port : null };
  }
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return { host: value, port: null };
  const port = Number.parseInt(value.slice(colon + 1), 10);
  if (!Number.isInteger(port)) return { host: value, port: null };
  return { host: value.slice(0, colon), port };
}

function fromUrl(url: URL): { target: Omit<RequestTarget, 'shape'>; options: Record<string, unknown> } {
  const port = url.port ? Number.parseInt(url.port, 10) : null;
  const path = `${url.pathname}${url.search}`;
  return {
    target: { hostname: url.hostname, port, protocol: url.protocol, path },
    options: {
      protocol: url.protocol,
      hostname: url.hostname,
      ...(port !== null ? { port } : {}),
      path,
      ...(url.username || url.password
        ? { auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` }
        : {}),
    },
  };
}

/**
 * Parses an `http.request`-style argument list.
 *
 * Returns null when the arguments cannot be interpreted; the caller then hands
 * the call straight to the original function rather than guessing.
 */
export function parseRequestArgs(args: unknown[]): ParsedRequestArgs | null {
  try {
    const [first, second, third] = args;
    let shape: RequestArgShape;
    let base: { target: Omit<RequestTarget, 'shape'>; options: Record<string, unknown> };
    let overrides: Record<string, unknown> = {};
    let callback: ((...a: unknown[]) => void) | undefined;

    if (typeof first === 'string') {
      shape = 'string';
      base = fromUrl(new URL(first));
    } else if (first instanceof URL) {
      shape = 'url';
      base = fromUrl(first);
    } else if (first && typeof first === 'object') {
      shape = 'options';
      const raw = first as Record<string, unknown>;
      const hostField = String(raw['hostname'] ?? raw['host'] ?? '');
      const split = raw['hostname'] ? { host: hostField, port: null } : splitHostHeader(hostField);
      const explicitPort =
        raw['port'] !== undefined && raw['port'] !== null && raw['port'] !== ''
          ? Number.parseInt(String(raw['port']), 10)
          : split.port;
      const path =
        typeof raw['path'] === 'string'
          ? raw['path']
          : `${String(raw['pathname'] ?? '/')}${String(raw['search'] ?? '')}`;
      base = {
        target: {
          hostname: split.host,
          port: Number.isInteger(explicitPort) ? (explicitPort as number) : null,
          protocol: String(raw['protocol'] ?? ''),
          path,
        },
        options: { ...raw },
      };
    } else {
      return null;
    }

    if (shape === 'options') {
      callback = typeof second === 'function' ? (second as (...a: unknown[]) => void) : undefined;
    } else if (typeof second === 'function') {
      callback = second as (...a: unknown[]) => void;
    } else if (second && typeof second === 'object') {
      overrides = { ...(second as Record<string, unknown>) };
      callback = typeof third === 'function' ? (third as (...a: unknown[]) => void) : undefined;
    }

    const options = { ...base.options, ...overrides };
    // An options override may move the request somewhere else entirely.
    const hostname = String(options['hostname'] ?? options['host'] ?? base.target.hostname);
    const portValue = options['port'];
    const port =
      portValue !== undefined && portValue !== null && portValue !== ''
        ? Number.parseInt(String(portValue), 10)
        : base.target.port;
    const path = typeof options['path'] === 'string' ? options['path'] : base.target.path;

    return {
      target: {
        hostname,
        port: Number.isInteger(port) ? (port as number) : null,
        protocol: String(options['protocol'] ?? base.target.protocol),
        path,
        shape,
      },
      options,
      callback,
    };
  } catch {
    return null;
  }
}

/** Resolves the effective port for a target, applying protocol defaults. */
export function effectivePort(target: RequestTarget, secureDefault: boolean): number {
  if (target.port !== null) return target.port;
  if (target.protocol === 'https:') return 443;
  if (target.protocol === 'http:') return 80;
  return secureDefault ? 443 : 80;
}
