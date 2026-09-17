/**
 * HTTP/2 interception.
 *
 * ConnectRPC — the protocol Cursor's agent transports speak — prefers HTTP/2,
 * and an interceptor that only wraps `http.request` misses it entirely. The
 * usual workaround is to edit Cursor's bundle so the HTTP/2 transport is never
 * selected, which breaks on every release that reshuffles the minified code.
 * Handling HTTP/2 directly removes the need for that edit.
 *
 * A session is established per authority, before any request path exists, so
 * this is a host-level capture: the session is pointed at the local cleartext
 * HTTP/2 listener while `:authority` and `:scheme` stay as Cursor set them, and
 * the server routes each stream individually.
 */

import type { Socket } from 'node:net';

import type { RuntimeContext } from '../context.js';
import { DeferredSocket } from '../deferred-socket.js';
import type { UplinkTarget } from '../uplink.js';

const LAYER = 'http2' as const;
const H2_ALPN = ['h2'];

interface Authority {
  host: string;
  port: number;
  secure: boolean;
}

function parseAuthority(input: unknown): Authority | null {
  try {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : null;
    if (!url) return null;
    const secure = url.protocol === 'https:';
    const port = url.port ? Number.parseInt(url.port, 10) : secure ? 443 : 80;
    return { host: url.hostname, port, secure };
  } catch {
    return null;
  }
}

export function installHttp2Layer(ctx: RuntimeContext): void {
  const { http2 } = ctx.originals.modules;

  http2.connect = function interceptedHttp2Connect(this: unknown, ...args: unknown[]): unknown {
    const [authorityArg, second, third] = args;
    const authority = parseAuthority(authorityArg);
    const options =
      second && typeof second === 'object' ? { ...(second as Record<string, unknown>) } : {};
    const listener =
      typeof second === 'function' ? second : typeof third === 'function' ? third : undefined;

    if (!authority || ctx.isBypassed(options) || !ctx.router().isCandidateHost(authority.host)) {
      return ctx.originals.outer.http2Connect(...(args as Parameters<typeof http2.connect>));
    }

    ctx.record(LAYER, 'captured');
    ctx.markBypassed(options);
    options['createConnection'] = () =>
      new DeferredSocket(() => resolveSession(ctx, authority)) as unknown as Socket;

    return listener
      ? ctx.originals.direct.http2Connect(
          authorityArg as never,
          options as never,
          listener as never,
        )
      : ctx.originals.direct.http2Connect(authorityArg as never, options as never);
  } as typeof http2.connect;
}

/**
 * Picks the session's transport once readiness is known.
 *
 * The fail-open branch negotiates ALPN `h2` against the official API, so a
 * session that could not reach the local server behaves exactly as it would
 * have without the toolkit installed.
 */
async function resolveSession(ctx: RuntimeContext, authority: Authority): Promise<Socket> {
  const uplink = ctx.cachedUplink() ?? (await ctx.awaitUplink(LAYER));
  if (uplink) return connectCleartext(ctx, uplink);
  return connectUpstream(ctx, authority);
}

function connectCleartext(ctx: RuntimeContext, uplink: UplinkTarget): Socket {
  return ctx.originals.direct.netConnect({ host: uplink.host, port: uplink.port });
}

function connectUpstream(ctx: RuntimeContext, authority: Authority): Socket {
  if (!authority.secure) {
    return ctx.originals.direct.netConnect({ host: authority.host, port: authority.port });
  }
  return ctx.originals.direct.tlsConnect({
    host: authority.host,
    port: authority.port,
    servername: authority.host,
    ALPNProtocols: H2_ALPN,
  }) as unknown as Socket;
}
