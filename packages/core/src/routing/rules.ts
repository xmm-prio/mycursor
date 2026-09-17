/**
 * Route rule grammar.
 *
 * A rule is a single string so the whole table survives a JSON round trip and
 * can be edited by hand:
 *
 *   `aiserver.v1.AuthService`                  whole ConnectRPC service
 *   `aiserver.v1.AiService/AvailableModels`    single ConnectRPC method
 *   `REST:/auth/poll`                          exact REST path
 *   `REST:/auth/*`                             REST path prefix
 */

export type RouteKind = 'service' | 'method' | 'rest';

export interface RouteRule {
  kind: RouteKind;
  /** Normalised match value: service name, `service/method`, or a REST path. */
  value: string;
  /** True when a `rest` rule ends in `*` and matches by prefix. */
  prefix: boolean;
  /** The original rule string, for diagnostics. */
  source: string;
}

const REST_PREFIX = 'REST:';

/**
 * Parses one rule string. Returns null when the string is not a usable rule;
 * the caller decides whether that is a warning or an error.
 */
export function parseRule(source: string): RouteRule | null {
  const trimmed = source.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  if (trimmed.startsWith(REST_PREFIX)) {
    let path = trimmed.slice(REST_PREFIX.length).trim();
    if (!path.startsWith('/')) path = `/${path}`;
    const prefix = path.endsWith('*');
    if (prefix) path = path.slice(0, -1);
    if (path.length < 2) return null;
    return { kind: 'rest', value: path, prefix, source: trimmed };
  }

  const slash = trimmed.indexOf('/');
  if (slash === -1) {
    if (!trimmed.includes('.')) return null;
    return { kind: 'service', value: trimmed, prefix: false, source: trimmed };
  }

  const service = trimmed.slice(0, slash);
  const method = trimmed.slice(slash + 1);
  if (!service.includes('.') || !method || method.includes('/')) return null;
  return { kind: 'method', value: trimmed, prefix: false, source: trimmed };
}

/** Strips query string and fragment from a request path. */
export function normalisePath(rawPath: string): string {
  let path = String(rawPath ?? '');
  const hash = path.indexOf('#');
  if (hash !== -1) path = path.slice(0, hash);
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);
  return path;
}

/**
 * Splits a ConnectRPC request path into its service and method parts.
 * Returns null for paths that are not shaped like `/pkg.Service/Method`.
 */
export function splitRpcPath(path: string): { service: string; method: string } | null {
  const trimmed = path.startsWith('/') ? path.slice(1) : path;
  const slash = trimmed.indexOf('/');
  if (slash <= 0) return null;
  const service = trimmed.slice(0, slash);
  const method = trimmed.slice(slash + 1);
  if (!service || !method || method.includes('/')) return null;
  return { service, method };
}
