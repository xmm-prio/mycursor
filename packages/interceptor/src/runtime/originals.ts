/**
 * Pristine references to the Node primitives the layers wrap.
 *
 * The payload is prepended to the target bundle, so it runs before Cursor's own
 * code installs its proxy agents. Capturing the primitives here — once, at that
 * moment — gives every layer two distinct escape hatches:
 *
 *  - `direct.*` bypasses every wrapper, including Cursor's proxy support, and
 *    is used for our own traffic to the local server;
 *  - `outer.*` is whatever was installed when we arrived, and is used for
 *    passthrough so requests we decline still honour the user's proxy settings.
 *
 * Losing that distinction is how naive hooks end up in infinite loops.
 *
 * The imports are static on purpose. Cursor ships CommonJS bundles, so the
 * bundler turns each one into a `require` call that resolves in the module
 * scope the payload is prepended to — no global lookup and no assumptions about
 * what is in scope.
 */

import dns from 'node:dns';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import * as module from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

export interface ModuleHandles {
  http: typeof http;
  https: typeof https;
  http2: typeof http2;
  net: typeof net;
  tls: typeof tls;
  dns: typeof dns;
}

export interface Originals {
  modules: ModuleHandles;
  /** Unwrapped primitives, used for traffic the toolkit itself originates. */
  direct: {
    httpRequest: typeof http.request;
    httpsRequest: typeof https.request;
    netConnect: typeof net.connect;
    tlsConnect: typeof tls.connect;
    http2Connect: typeof http2.connect;
    dnsLookup: typeof dns.lookup;
  };
  /** Primitives as found on arrival, used for passthrough. */
  outer: {
    httpRequest: typeof http.request;
    httpsRequest: typeof https.request;
    httpGet: typeof http.get;
    httpsGet: typeof https.get;
    netConnect: typeof net.connect;
    tlsConnect: typeof tls.connect;
    http2Connect: typeof http2.connect;
    dnsLookup: typeof dns.lookup;
    fetch: typeof globalThis.fetch | undefined;
  };
}

/**
 * VSCode stores the untouched http/https modules on `__vscodeOriginal` before
 * installing its proxy agent. Preferring that reference keeps our own outbound
 * calls out of the proxy path.
 */
function unwrapVscode<T extends object>(mod: T): T {
  const stashed = (mod as { __vscodeOriginal?: T }).__vscodeOriginal;
  return stashed && typeof stashed === 'object' ? stashed : mod;
}

export function captureOriginals(): Originals {
  const rawHttp = unwrapVscode(http);
  const rawHttps = unwrapVscode(https);

  return {
    modules: { http, https, http2, net, tls, dns },
    direct: {
      httpRequest: rawHttp.request.bind(rawHttp),
      httpsRequest: rawHttps.request.bind(rawHttps),
      netConnect: net.connect.bind(net),
      tlsConnect: tls.connect.bind(tls),
      http2Connect: http2.connect.bind(http2),
      dnsLookup: dns.lookup.bind(dns),
    },
    outer: {
      httpRequest: http.request.bind(http),
      httpsRequest: https.request.bind(https),
      httpGet: http.get.bind(http),
      httpsGet: https.get.bind(https),
      netConnect: net.connect.bind(net),
      tlsConnect: tls.connect.bind(tls),
      http2Connect: http2.connect.bind(http2),
      dnsLookup: dns.lookup.bind(dns),
      fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined,
    },
  };
}

/**
 * Makes ESM named imports observe the patched functions.
 *
 * Without this, `import { request } from 'node:http'` keeps the binding it
 * captured at module evaluation time and escapes interception entirely.
 */
export function syncEsmExports(): void {
  try {
    module.syncBuiltinESMExports?.();
  } catch {
    // Older runtimes lack the hook; the CommonJS patch still applies.
  }
}
