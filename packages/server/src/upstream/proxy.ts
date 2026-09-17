/**
 * Forwarding a captured request to the official API.
 *
 * This is what makes host-level capture safe. The socket layer takes whole
 * connections before any path is known, so the server receives requests no
 * route rule claims — model-unrelated traffic that Cursor needs in order to
 * keep working. Forwarding them faithfully is the difference between a BYOK
 * setup and a broken IDE, and it is the mechanism behind the promise that
 * Cursor's native features survive installation.
 *
 * "Faithfully" is load-bearing: the method, path, body and headers go out as
 * they came in, minus the toolkit's own provenance headers and the hop-by-hop
 * headers HTTP forbids forwarding.
 */

import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';

import type { UpstreamConfig } from '@mycursor/core/config';
import type { Logger } from '@mycursor/core/logging';

import type { Exchange } from '../listener/exchange.js';

/** Headers that describe a single hop and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
]);

/** The toolkit's own headers, which upstream must never see. */
const TOOLKIT_HEADERS = new Set([
  'x-mycursor-upstream',
  'x-mycursor-origin',
  'x-mycursor-window',
  'x-mycursor-probe',
]);

export const DEFAULT_UPSTREAM_HOST = 'api2.cursor.sh';

export interface ProxyDeps {
  config: () => UpstreamConfig;
  logger: Logger;
}

export interface UpstreamResult {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export class UpstreamProxy {
  constructor(private readonly deps: ProxyDeps) {}

  /**
   * Fetches the upstream response into memory instead of streaming it back.
   *
   * Needed by handlers that answer a method themselves but want the official
   * answer first — the model list is built by appending to it, so that turning
   * BYOK on adds models rather than replacing them.
   *
   * Returns null when upstream cannot be reached, which is an expected state
   * for a session with no Cursor account.
   */
  async fetch(exchange: Exchange): Promise<UpstreamResult | null> {
    const policy = this.deps.config();
    const host = exchange.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
    const headers = this.forwardableHeaders(exchange.headers, host);
    const body = await exchange.body();

    return new Promise<UpstreamResult | null>((resolve) => {
      let settled = false;
      const finish = (value: UpstreamResult | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      const upstream = httpsRequest(
        {
          host,
          port: policy.port,
          servername: host,
          method: exchange.method,
          path: exchange.path,
          headers: { ...headers, ...(body.length > 0 ? { 'content-length': String(body.length) } : {}) },
          timeout: policy.timeoutMs,
        },
        (response: IncomingMessage) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const responseHeaders: Record<string, string> = {};
            for (const [key, value] of Object.entries(response.headers)) {
              if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
              responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
            }
            finish({
              status: response.statusCode ?? 502,
              headers: responseHeaders,
              body: new Uint8Array(Buffer.concat(chunks)),
            });
          });
          response.on('error', () => finish(null));
        },
      );

      upstream.on('timeout', () => upstream.destroy(new Error('upstream timed out')));
      upstream.on('error', (error) => {
        this.deps.logger.debug('upstream fetch failed', {
          host,
          path: exchange.path,
          error: error.message,
        });
        finish(null);
      });

      if (body.length > 0) upstream.write(Buffer.from(body));
      upstream.end();
    });
  }

  /**
   * Streams a request upstream and the response back.
   *
   * HTTP/2 pseudo-headers are dropped: the upstream connection is HTTP/1.1,
   * whose semantics are equivalent for these requests, and using one transport
   * keeps the proxy a single code path.
   */
  async forward(exchange: Exchange): Promise<void> {
    const policy = this.deps.config();
    if (policy.policy === 'reject') {
      exchange.sendJson(502, {
        error: 'mycursor: upstream forwarding is disabled by configuration',
        path: exchange.path,
      });
      return;
    }

    const host = exchange.upstreamHost ?? DEFAULT_UPSTREAM_HOST;
    const headers = this.forwardableHeaders(exchange.headers, host);
    const body = await exchange.body();

    await new Promise<void>((resolve) => {
      const upstream = httpsRequest(
        {
          host,
          port: policy.port,
          servername: host,
          method: exchange.method,
          path: exchange.path,
          headers: { ...headers, ...(body.length > 0 ? { 'content-length': String(body.length) } : {}) },
          timeout: policy.timeoutMs,
        },
        (response: IncomingMessage) => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            if (HOP_BY_HOP.has(key.toLowerCase())) continue;
            responseHeaders[key] = Array.isArray(value) ? value.join(', ') : String(value);
          }

          const writer = exchange.beginStream(response.statusCode ?? 502, responseHeaders);
          response.on('data', (chunk: Buffer) => writer.write(chunk));
          response.on('end', () => {
            writer.end();
            resolve();
          });
          response.on('error', (error) => {
            this.deps.logger.warn('upstream response failed mid-stream', {
              host,
              path: exchange.path,
              error: error.message,
            });
            writer.end();
            resolve();
          });
        },
      );

      upstream.on('timeout', () => upstream.destroy(new Error('upstream timed out')));
      upstream.on('error', (error) => {
        this.deps.logger.warn('upstream request failed', {
          host,
          path: exchange.path,
          error: error.message,
        });
        // 502 rather than a toolkit-shaped error: from the client's point of
        // view the official API is what did not answer.
        try {
          exchange.sendJson(502, { error: `mycursor: upstream unreachable: ${error.message}` });
        } catch {
          exchange.destroy();
        }
        resolve();
      });

      if (body.length > 0) upstream.write(Buffer.from(body));
      upstream.end();
    });
  }

  private forwardableHeaders(
    headers: Record<string, string>,
    host: string,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      // HTTP/2 pseudo-headers have no HTTP/1.1 equivalent.
      if (lower.startsWith(':')) continue;
      if (HOP_BY_HOP.has(lower) || TOOLKIT_HEADERS.has(lower)) continue;
      result[lower] = value;
    }
    result['host'] = host;
    return result;
  }
}
