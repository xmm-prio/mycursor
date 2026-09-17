/**
 * Header rewriting for redirected requests.
 *
 * Two pieces of provenance travel with every redirected request:
 *
 *  - `x-mycursor-upstream` names the host the client originally addressed, so
 *    the server can forward a request no rule claimed back to the real API;
 *  - `x-mycursor-origin` names the patched process, which is what makes a
 *    misbehaving window, subagent, or remote host identifiable in one log.
 *
 * `host` and `:authority` are dropped because they would otherwise advertise
 * the official API to a loopback listener.
 */

export const UPSTREAM_HEADER = 'x-mycursor-upstream';
export const ORIGIN_HEADER = 'x-mycursor-origin';
export const WINDOW_HEADER = 'x-mycursor-window';

export type HeaderBag = Record<string, unknown>;

/** Normalises every shape Node and fetch accept into a plain object. */
export function toHeaderBag(headers: unknown): HeaderBag {
  const result: HeaderBag = {};
  if (!headers) return result;

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  if (Array.isArray(headers)) {
    // Either [[k, v], ...] or the flat [k, v, k, v, ...] form.
    if (headers.length > 0 && Array.isArray(headers[0])) {
      for (const entry of headers as unknown[][]) {
        if (entry && entry.length >= 2) result[String(entry[0])] = entry[1];
      }
    } else {
      for (let i = 0; i + 1 < headers.length; i += 2) {
        result[String(headers[i])] = headers[i + 1];
      }
    }
    return result;
  }

  if (typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      result[key] = value;
    }
  }
  return result;
}

export interface ProvenanceInput {
  /** Host the client originally addressed. */
  upstreamHost: string;
  /** Short label for the patched process. */
  processLabel: string;
  /** Cursor window id, when it can be derived from the environment. */
  windowId?: string | null;
}

/**
 * Returns a header bag suitable for a redirected request: authority headers
 * removed, provenance added, everything else preserved.
 */
export function withProvenance(headers: unknown, input: ProvenanceInput): HeaderBag {
  const bag = toHeaderBag(headers);
  for (const key of Object.keys(bag)) {
    const lower = key.toLowerCase();
    if (lower === 'host' || lower === ':authority') delete bag[key];
  }
  bag[UPSTREAM_HEADER] = input.upstreamHost;
  bag[ORIGIN_HEADER] = input.processLabel;
  if (input.windowId) bag[WINDOW_HEADER] = input.windowId;
  return bag;
}

/**
 * Derives the Cursor window id from the process title.
 *
 * Cursor tags renderer and helper processes as `... [<window>-<n>] ...`, which
 * is the only handle a patched extension-host process has on the window it
 * belongs to. Used to attribute traffic when several windows are open.
 */
export function detectWindowId(env: NodeJS.ProcessEnv = process.env): string | null {
  const title = String(env['VSCODE_PROCESS_TITLE'] ?? '');
  const match = title.match(/\[(\d+)-\d+\]/);
  return match?.[1] ?? null;
}
