/**
 * WebSocket interception.
 *
 * Cursor's agent transport can upgrade to a WebSocket at `/agent/v1/run`. The
 * reference implementation deals with that by editing the minified bundle until
 * the WebSocket branch is unreachable, which has to be re-derived for every
 * release.
 *
 * This toolkit keeps the decision in configuration instead. The upgrade path is
 * an ordinary route rule, so the handshake — which the `ws` package performs
 * through `http.request` — is already captured by the HTTP/1.1 layer and lands
 * on the local server, which then applies `interception.websocketPolicy`:
 * refuse the upgrade so the client falls back to SSE, or serve it.
 *
 * This layer only covers clients that bypass `http.request` entirely, namely
 * the global `WebSocket` constructor.
 */

import type { RuntimeContext } from '../context.js';

const LAYER = 'websocket' as const;

/** Carries the intended upstream, which a WebSocket URL rewrite would lose. */
export const UPSTREAM_QUERY_PARAM = '__mycursor_upstream';

export function installWebSocketLayer(ctx: RuntimeContext): void {
  const policy = ctx.config().interception.websocketPolicy;
  if (policy === 'ignore') {
    ctx.logger.debug('websocket layer skipped: policy is "ignore"');
    return;
  }

  const OriginalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof OriginalWebSocket !== 'function') {
    ctx.logger.debug('websocket layer skipped: no global WebSocket in this runtime');
    return;
  }

  const Wrapped = function PatchedWebSocket(this: unknown, ...args: unknown[]): unknown {
    const [urlArg, protocols] = args;
    const rewritten = rewriteUrl(ctx, urlArg);
    if (!rewritten) {
      ctx.record(LAYER, 'passthrough');
      return Reflect.construct(OriginalWebSocket as never, args, Wrapped as never);
    }
    ctx.record(LAYER, 'intercepted');
    return Reflect.construct(
      OriginalWebSocket as never,
      protocols === undefined ? [rewritten] : [rewritten, protocols],
      Wrapped as never,
    );
  };

  // Preserve the constructor's own surface: `readyState` constants and the
  // prototype chain are part of the contract callers rely on.
  Object.setPrototypeOf(Wrapped, OriginalWebSocket as object);
  Wrapped.prototype = (OriginalWebSocket as { prototype: object }).prototype;
  (globalThis as { WebSocket?: unknown }).WebSocket = Wrapped;
}

/**
 * Returns the loopback URL for a captured WebSocket, or null to leave it alone.
 */
function rewriteUrl(ctx: RuntimeContext, urlArg: unknown): string | null {
  let url: URL;
  try {
    url = urlArg instanceof URL ? new URL(urlArg.toString()) : new URL(String(urlArg));
  } catch {
    return null;
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null;

  const decision = ctx.decide({ host: url.hostname, path: `${url.pathname}${url.search}` });
  if (decision.action === 'passthrough') return null;

  const uplink = ctx.cachedUplink();
  if (!uplink) return null;

  const upstreamHost = url.hostname;
  url.protocol = 'ws:';
  url.hostname = uplink.host;
  url.port = String(uplink.port);
  url.searchParams.set(UPSTREAM_QUERY_PARAM, upstreamHost);
  return url.toString();
}
