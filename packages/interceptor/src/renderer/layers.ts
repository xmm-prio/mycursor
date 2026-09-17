/**
 * Renderer interception: `fetch` and `WebSocket`.
 *
 * Cursor's chat surface talks to the API from the renderer, and ConnectRPC's
 * web transport is built on `fetch`, so these two primitives cover the whole
 * renderer-side surface. There is no socket layer to fall back on here, which
 * is why both wrappers fail open on every error path rather than surfacing a
 * failure to the UI.
 */

import { ORIGIN_HEADER, UPSTREAM_HEADER } from '../runtime/headers.js';

import type { RendererReadiness } from './readiness.js';
import type { RendererState } from './state.js';

/** Carries the intended upstream, which a WebSocket URL rewrite would lose. */
export const UPSTREAM_QUERY_PARAM = '__mycursor_upstream';

export interface RendererLayerDeps {
  state: RendererState;
  readiness: RendererReadiness;
  nativeFetch: typeof globalThis.fetch;
}

/**
 * Resolves a request argument to a URL.
 *
 * Relative URLs are resolved against the document, reached through
 * `globalThis` rather than the ambient `location` binding so the module stays
 * type-checkable without pulling in DOM declarations that would collide with
 * Node's own `fetch` types in the sibling runtime.
 */
function parseUrl(input: unknown): URL | null {
  const base = (globalThis as { location?: { href?: string } }).location?.href;
  try {
    if (typeof input === 'string') return new URL(input, base);
    if (input instanceof URL) return input;
    if (typeof Request !== 'undefined' && input instanceof Request) return new URL(input.url);
    const maybe = input as { url?: unknown } | null;
    if (maybe && typeof maybe.url === 'string') return new URL(maybe.url, base);
  } catch {
    return null;
  }
  return null;
}

export function installRendererFetchLayer(deps: RendererLayerDeps): void {
  const { state, readiness, nativeFetch } = deps;

  globalThis.fetch = async function interceptedFetch(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> {
    const url = parseUrl(input);
    if (!url) return nativeFetch(input, init);

    const decision = state
      .currentRouter()
      .resolve({ host: url.hostname, path: `${url.pathname}${url.search}` });
    if (decision.action === 'passthrough') return nativeFetch(input, init);

    const healthy = readiness.cached() ?? (await readiness.check());
    if (!healthy) return nativeFetch(input, init);

    const redirected = new URL(`${state.baseUrl()}${url.pathname}${url.search}`);
    const headers = new Headers(input instanceof Request ? input.headers : (init?.headers ?? {}));
    // The authority is lost when the URL is rewritten, so the upstream host
    // travels in a header instead; the server needs it to forward anything a
    // rule does not claim.
    headers.set(UPSTREAM_HEADER, url.hostname);
    headers.set(ORIGIN_HEADER, state.options.processLabel);

    try {
      if (typeof Request !== 'undefined' && input instanceof Request) {
        return await nativeFetch(
          new Request(redirected, { ...input, headers } as unknown as RequestInit),
        );
      }
      return await nativeFetch(redirected, { ...(init ?? {}), headers });
    } catch (error) {
      // A redirect that fails must not become a failed prompt.
      readiness.invalidate();
      console.warn(
        `[mycursor:${state.options.processLabel}] redirect failed, retrying against the official API: ${
          (error as Error).message
        }`,
      );
      return nativeFetch(input, init);
    }
  };
}

export function installRendererWebSocketLayer(deps: RendererLayerDeps): void {
  const { state, readiness } = deps;
  const OriginalWebSocket = globalThis.WebSocket;
  if (typeof OriginalWebSocket !== 'function') return;

  const Wrapped = function PatchedWebSocket(this: unknown, ...args: unknown[]): unknown {
    const rewritten = rewrite(args[0]);
    const effectiveArgs = rewritten === null ? args : [rewritten, ...args.slice(1)];
    return Reflect.construct(OriginalWebSocket, effectiveArgs, Wrapped as never);
  };

  function rewrite(urlArg: unknown): string | null {
    const url = parseUrl(urlArg);
    if (!url || (url.protocol !== 'ws:' && url.protocol !== 'wss:')) return null;

    const decision = state
      .currentRouter()
      .resolve({ host: url.hostname, path: `${url.pathname}${url.search}` });
    if (decision.action === 'passthrough') return null;

    // The WebSocket constructor is synchronous, so only a cached verdict can
    // be used; an unknown state leaves the connection on its native route and
    // triggers a probe for next time.
    if (readiness.cached() !== true) {
      void readiness.check();
      return null;
    }

    const upstreamHost = url.hostname;
    const target = new URL(url.toString());
    target.protocol = 'ws:';
    target.host = `${state.options.server.host}:${state.options.server.port}`;
    target.searchParams.set(UPSTREAM_QUERY_PARAM, upstreamHost);
    return target.toString();
  }

  Object.setPrototypeOf(Wrapped, OriginalWebSocket);
  Wrapped.prototype = OriginalWebSocket.prototype;
  globalThis.WebSocket = Wrapped as unknown as typeof WebSocket;
}
