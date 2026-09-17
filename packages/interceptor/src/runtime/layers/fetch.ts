/**
 * `fetch` interception.
 *
 * Unlike the other layers this one is natively asynchronous, so readiness can
 * simply be awaited and the fail-open path is exact: the original arguments are
 * handed to the original `fetch` untouched.
 *
 * A `fetch` request loses its authority when the URL is rewritten, so the
 * upstream host travels in `x-mycursor-upstream` instead of `Host`.
 */

import { ORIGIN_HEADER, UPSTREAM_HEADER, WINDOW_HEADER } from '../headers.js';
import type { RuntimeContext } from '../context.js';

const LAYER = 'fetch' as const;

/** Mirrors the global `fetch` signature without depending on DOM lib types. */
type FetchInput = Parameters<typeof globalThis.fetch>[0];
type FetchInit = Parameters<typeof globalThis.fetch>[1];

interface FetchTarget {
  url: URL;
  request: Request | null;
}

function parseFetchArgs(input: unknown): FetchTarget | null {
  try {
    if (typeof input === 'string') return { url: new URL(input), request: null };
    if (input instanceof URL) return { url: input, request: null };
    if (typeof Request !== 'undefined' && input instanceof Request) {
      return { url: new URL(input.url), request: input };
    }
    const maybe = input as { url?: unknown } | null;
    if (maybe && typeof maybe.url === 'string') return { url: new URL(maybe.url), request: null };
  } catch {
    return null;
  }
  return null;
}

export function installFetchLayer(ctx: RuntimeContext): void {
  const original = ctx.originals.outer.fetch;
  if (!original) {
    ctx.logger.debug('fetch layer skipped: no global fetch in this runtime');
    return;
  }

  globalThis.fetch = async function interceptedFetch(
    input: FetchInput,
    init?: FetchInit,
  ): Promise<Response> {
    const parsed = parseFetchArgs(input);
    if (!parsed) return original(input, init);

    const decision = ctx.decide({
      host: parsed.url.hostname,
      path: `${parsed.url.pathname}${parsed.url.search}`,
    });
    if (decision.action === 'passthrough') {
      ctx.record(LAYER, 'passthrough');
      return original(input, init);
    }

    const uplink = ctx.cachedUplink() ?? (await ctx.awaitUplink(LAYER));
    if (!uplink) {
      ctx.record(LAYER, 'passthrough');
      return original(input, init);
    }

    ctx.record(LAYER, 'intercepted');
    const redirected = new URL(parsed.url.toString());
    redirected.protocol = 'http:';
    redirected.hostname = uplink.host;
    redirected.port = String(uplink.port);

    const headers = new Headers(parsed.request ? parsed.request.headers : (init?.headers ?? {}));
    headers.set(UPSTREAM_HEADER, parsed.url.hostname);
    headers.set(ORIGIN_HEADER, ctx.options.processLabel);
    if (ctx.windowId) headers.set(WINDOW_HEADER, ctx.windowId);

    try {
      if (parsed.request) {
        // Rebuilding from the Request preserves method, body and abort signal.
        return await original(
          new Request(redirected, { ...parsed.request, headers } as unknown as FetchInit),
        );
      }
      return await original(redirected, { ...(init ?? {}), headers } as FetchInit);
    } catch (error) {
      ctx.record(LAYER, 'errors');
      ctx.logger.warn('fetch redirect failed, retrying against the official API', {
        host: parsed.url.hostname,
        error: (error as Error).message,
      });
      return original(input, init);
    }
  };
}
