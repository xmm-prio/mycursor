/**
 * HTTP/1.1 interception.
 *
 * The layer deliberately does not rewrite the request. Host header, path, and
 * body all stay exactly as Cursor produced them; only the socket's destination
 * is chosen, and it is chosen asynchronously inside `createConnection`.
 *
 * That split buys two properties the naive "rewrite the URL to localhost"
 * approach cannot have:
 *
 *  - a request issued while the BYOK server is still starting can pause until
 *    the server answers, instead of failing the user's first prompt;
 *  - if the server never comes up, the very same request object connects to
 *    the official API and succeeds, because nothing about it was rewritten.
 */

import type { Socket } from 'node:net';

import { ORIGIN_HEADER, WINDOW_HEADER } from '../headers.js';
import type { RuntimeContext } from '../context.js';
import { effectivePort, parseRequestArgs, type RequestTarget } from '../request-target.js';
import type { UplinkTarget } from '../uplink.js';

type ConnectionCallback = (error: Error | null, socket?: Socket) => void;
type CreateConnection = (options: Record<string, unknown>, callback: ConnectionCallback) => Socket | undefined;

const LAYER = 'http1' as const;

export function installHttp1Layer(ctx: RuntimeContext): void {
  const { http, https } = ctx.originals.modules;

  const wrapRequest = (secure: boolean) =>
    function interceptedRequest(this: unknown, ...args: unknown[]): unknown {
      // A declined request is stamped on the way out. The marker survives the
      // agent's option merge, so the socket-level layer below recognises the
      // decision instead of capturing the connection a second time — which is
      // what keeps an unclaimed path on its original, native route.
      const passthrough = (): unknown => {
        const marked = markArgsBypassed(ctx, args);
        return secure
          ? ctx.originals.outer.httpsRequest(...(marked as Parameters<typeof https.request>))
          : ctx.originals.outer.httpRequest(...(marked as Parameters<typeof http.request>));
      };

      let parsed;
      try {
        parsed = parseRequestArgs(args);
      } catch {
        ctx.record(LAYER, 'errors');
        return passthrough();
      }
      if (!parsed) return passthrough();
      if (ctx.isBypassed(parsed.options)) return passthrough();

      const decision = ctx.decide({ host: parsed.target.hostname, path: parsed.target.path });
      if (decision.action === 'passthrough') {
        ctx.record(LAYER, 'passthrough');
        return passthrough();
      }

      ctx.record(LAYER, 'intercepted');
      try {
        return dispatchRedirected(ctx, secure, parsed.options, parsed.target, parsed.callback);
      } catch (error) {
        ctx.record(LAYER, 'errors');
        ctx.logger.warn('http1 redirect failed, passing through', {
          host: parsed.target.hostname,
          error: (error as Error).message,
        });
        return passthrough();
      }
    };

  http.request = wrapRequest(false) as typeof http.request;
  https.request = wrapRequest(true) as typeof https.request;

  // `get` is `request` plus an immediate `end()`; routing it through our own
  // `request` keeps a single decision path.
  http.get = function interceptedHttpGet(this: unknown, ...args: unknown[]): unknown {
    const request = (http.request as (...a: unknown[]) => { end: () => void })(...args);
    request.end();
    return request;
  } as typeof http.get;
  https.get = function interceptedHttpsGet(this: unknown, ...args: unknown[]): unknown {
    const request = (https.request as (...a: unknown[]) => { end: () => void })(...args);
    request.end();
    return request;
  } as typeof https.get;
}

/**
 * Returns the argument list with the bypass marker attached.
 *
 * `http.request` accepts the options object in three different positions
 * depending on whether a URL was supplied, so the marker has to be placed
 * rather than simply assigned.
 */
function markArgsBypassed(ctx: RuntimeContext, args: unknown[]): unknown[] {
  const [first, second] = args;

  if (first && typeof first === 'object' && !(first instanceof URL)) {
    return [ctx.markBypassed({ ...(first as Record<string, unknown>) }), ...args.slice(1)];
  }
  if (second && typeof second === 'object') {
    return [first, ctx.markBypassed({ ...(second as Record<string, unknown>) }), ...args.slice(2)];
  }
  // URL form with no options object: insert one carrying only the marker.
  return [first, ctx.markBypassed({}), ...args.slice(1)];
}

/**
 * Issues the request with an unchanged wire representation and a deferred
 * destination.
 */
function dispatchRedirected(
  ctx: RuntimeContext,
  secure: boolean,
  original: Record<string, unknown>,
  target: RequestTarget,
  callback: ((...args: unknown[]) => void) | undefined,
): unknown {
  const options: Record<string, unknown> = { ...original };

  // The caller's agent may carry the user's proxy configuration. It is set
  // aside rather than discarded, so the fail-open path can still reach the
  // official API through that proxy.
  const callerAgent = extractAgent(original['agent']);

  // `options.createConnection` is honoured only when no agent is present at
  // all. `agent: false` does not mean "no agent" — it makes Node construct a
  // fresh default one, which would then resolve and dial the original host and
  // defeat the whole layer.
  delete options['agent'];
  delete options['createConnection'];

  // Always speak plaintext HTTP/1.1 on the wire; `createConnection` supplies
  // either a loopback socket or a TLS socket to the official API.
  options['protocol'] = 'http:';
  options['createConnection'] = buildCreateConnection(ctx, secure, target, callerAgent);
  ctx.markBypassed(options);

  // Provenance is only attached once a healthy server is known, so headers
  // never leak to the official API on the fallback path.
  const knownTarget = ctx.cachedUplink();
  if (knownTarget) {
    options['headers'] = {
      ...(options['headers'] as Record<string, unknown> | undefined),
      [ORIGIN_HEADER]: ctx.options.processLabel,
      ...(ctx.windowId ? { [WINDOW_HEADER]: ctx.windowId } : {}),
    };
  }

  return callback
    ? ctx.originals.direct.httpRequest(options as never, callback as never)
    : ctx.originals.direct.httpRequest(options as never);
}

/**
 * Chooses the socket destination once the readiness question has an answer.
 *
 * Returning `undefined` and calling the callback later is a documented
 * `createConnection` contract, and is the only place in Node's synchronous
 * request API where an await can be hidden.
 */
function buildCreateConnection(
  ctx: RuntimeContext,
  secure: boolean,
  target: RequestTarget,
  callerAgent: ProxyCapableAgent | null,
): CreateConnection {
  return (connectionOptions, callback) => {
    const cached = ctx.cachedUplink();
    if (cached) return connectToUplink(ctx, cached);

    void ctx
      .awaitUplink(LAYER)
      .then((uplink) => {
        if (uplink) {
          callback(null, connectToUplink(ctx, uplink));
          return;
        }
        fallBackToUpstream(ctx, secure, target, callerAgent, connectionOptions, callback);
      })
      .catch((error: Error) => callback(error));
    return undefined;
  };
}

/** An agent that can build its own connection, such as a proxy agent. */
interface ProxyCapableAgent {
  createConnection: (options: Record<string, unknown>, callback: ConnectionCallback) => Socket | undefined;
}

function extractAgent(value: unknown): ProxyCapableAgent | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { createConnection?: unknown };
  return typeof candidate.createConnection === 'function' ? (value as ProxyCapableAgent) : null;
}

/**
 * Fail-open: reach the host Cursor originally asked for.
 *
 * The caller's agent gets first refusal because it is where proxy support
 * lives — a user behind a corporate proxy must not lose connectivity just
 * because the local server happened to be down.
 */
function fallBackToUpstream(
  ctx: RuntimeContext,
  secure: boolean,
  target: RequestTarget,
  callerAgent: ProxyCapableAgent | null,
  connectionOptions: Record<string, unknown>,
  callback: ConnectionCallback,
): void {
  if (callerAgent) {
    try {
      const viaAgent = callerAgent.createConnection(
        ctx.markBypassed({ ...connectionOptions, ...restoreUpstreamOptions(secure, target) }),
        callback,
      );
      if (viaAgent) callback(null, viaAgent);
      return;
    } catch (error) {
      ctx.logger.debug('caller agent could not build the fallback connection', {
        error: (error as Error).message,
      });
    }
  }
  callback(null, connectToUpstream(ctx, secure, target));
}

/** Restores the destination the request was originally addressed to. */
function restoreUpstreamOptions(secure: boolean, target: RequestTarget): Record<string, unknown> {
  return {
    host: target.hostname,
    hostname: target.hostname,
    port: effectivePort(target, secure),
    protocol: secure ? 'https:' : 'http:',
    ...(secure ? { servername: target.hostname } : {}),
  };
}

function connectToUplink(ctx: RuntimeContext, uplink: UplinkTarget): Socket {
  return ctx.originals.direct.netConnect({ host: uplink.host, port: uplink.port });
}

/**
 * Direct connection to the host Cursor originally asked for.
 *
 * Because nothing in the request was rewritten, the bytes this socket carries
 * are byte-identical to an uninstrumented Cursor request.
 */
function connectToUpstream(ctx: RuntimeContext, secure: boolean, target: RequestTarget): Socket {
  const port = effectivePort(target, secure);
  if (!secure) {
    return ctx.originals.direct.netConnect({ host: target.hostname, port });
  }
  return ctx.originals.direct.tlsConnect({
    host: target.hostname,
    port,
    servername: target.hostname,
  }) as unknown as Socket;
}
