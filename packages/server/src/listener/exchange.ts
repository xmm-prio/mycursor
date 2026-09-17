/**
 * One request shape for four transports.
 *
 * The interception layers deliver traffic over plaintext HTTP/1.1, cleartext
 * HTTP/2, TLS HTTP/1.1 and TLS HTTP/2 — the socket layer preserves whatever
 * the client negotiated. Handlers would otherwise each need four code paths,
 * and the differences that actually matter are few: where the authority lives,
 * and how a response is written.
 *
 * Normalising here also concentrates the one piece of routing information the
 * whole server depends on: which upstream host the client originally meant.
 */

import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import type { Http2ServerRequest, Http2ServerResponse } from 'node:http2';
import type { TLSSocket } from 'node:tls';

import type { WireResponse } from '@mycursor/protocol/connect';

export type Transport = 'http1' | 'http2';

export interface StreamWriter {
  write(chunk: Uint8Array): void;
  end(trailers?: Record<string, string>): void;
  readonly closed: boolean;
  onClose(listener: () => void): void;
}

export interface Exchange {
  method: string;
  /** Path including query string. */
  path: string;
  headers: Record<string, string>;
  transport: Transport;
  secure: boolean;
  /**
   * The host the client originally addressed.
   *
   * Resolved from, in order: the provenance header a URL-rewriting layer adds,
   * the HTTP/2 authority, the HTTP/1.1 `Host` header, and the TLS server name
   * from a socket-level capture. Without it the server cannot forward a
   * request that no route rule claims, which is what preserves Cursor's native
   * behaviour.
   */
  upstreamHost: string | null;
  body(): Promise<Uint8Array>;
  bodyStream(): AsyncIterable<Uint8Array>;
  send(response: WireResponse): void;
  sendJson(status: number, value: unknown, headers?: Record<string, string>): void;
  beginStream(status: number, headers: Record<string, string>): StreamWriter;
  /** Aborts the exchange, e.g. to refuse a WebSocket upgrade. */
  destroy(): void;
}

const UPSTREAM_HEADER = 'x-mycursor-upstream';

function normaliseHeaders(raw: IncomingHttpHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return headers;
}

function stripPort(host: string | undefined): string | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    const close = trimmed.indexOf(']');
    return close === -1 ? trimmed : trimmed.slice(1, close);
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) return trimmed.slice(0, colon);
  return trimmed;
}

function serverName(socket: unknown): string | null {
  const candidate = socket as TLSSocket & { servername?: string };
  const name = candidate?.servername;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function resolveUpstreamHost(
  headers: Record<string, string>,
  socket: unknown,
): string | null {
  return (
    stripPort(headers[UPSTREAM_HEADER]) ??
    stripPort(headers[':authority']) ??
    stripPort(headers['host']) ??
    serverName(socket)
  );
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** Wraps an HTTP/1.1 request-response pair. */
export function fromHttp1(request: IncomingMessage, response: ServerResponse): Exchange {
  const headers = normaliseHeaders(request.headers);
  let cachedBody: Promise<Uint8Array> | null = null;

  return {
    method: request.method ?? 'GET',
    path: request.url ?? '/',
    headers,
    transport: 'http1',
    secure: Boolean((request.socket as TLSSocket).encrypted),
    upstreamHost: resolveUpstreamHost(headers, request.socket),
    body() {
      cachedBody ??= collect(request as unknown as AsyncIterable<Uint8Array>);
      return cachedBody;
    },
    bodyStream() {
      return request as unknown as AsyncIterable<Uint8Array>;
    },
    send(wire) {
      response.writeHead(wire.status, wire.headers);
      response.end(wire.body.length > 0 ? Buffer.from(wire.body) : undefined);
    },
    sendJson(status, value, extra) {
      const payload = Buffer.from(JSON.stringify(value), 'utf-8');
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...(extra ?? {}),
      });
      response.end(payload);
    },
    beginStream(status, streamHeaders) {
      response.writeHead(status, streamHeaders);
      return {
        write(chunk) {
          if (!response.writableEnded) response.write(Buffer.from(chunk));
        },
        end() {
          if (!response.writableEnded) response.end();
        },
        get closed() {
          return response.writableEnded || response.destroyed;
        },
        onClose(listener) {
          response.on('close', listener);
        },
      };
    },
    destroy() {
      request.socket.destroy();
    },
  };
}

/** Wraps an HTTP/2 stream. */
export function fromHttp2(request: Http2ServerRequest, response: Http2ServerResponse): Exchange {
  const headers = normaliseHeaders(request.headers as IncomingHttpHeaders);
  let cachedBody: Promise<Uint8Array> | null = null;
  const socket = request.stream.session?.socket;

  return {
    method: request.method ?? 'GET',
    path: request.url ?? '/',
    headers,
    transport: 'http2',
    secure: Boolean((socket as TLSSocket | undefined)?.encrypted),
    upstreamHost: resolveUpstreamHost(headers, socket),
    body() {
      cachedBody ??= collect(request as unknown as AsyncIterable<Uint8Array>);
      return cachedBody;
    },
    bodyStream() {
      return request as unknown as AsyncIterable<Uint8Array>;
    },
    send(wire) {
      // HTTP/2 forbids connection-specific headers, and trailers must be
      // announced before the body ends.
      const outgoing = { ...wire.headers };
      delete outgoing['connection'];
      delete outgoing['transfer-encoding'];
      response.writeHead(wire.status, outgoing);
      if (wire.trailers) response.stream.sendTrailers(wire.trailers);
      if (wire.body.length > 0) response.end(Buffer.from(wire.body));
      else response.end();
    },
    sendJson(status, value, extra) {
      const payload = Buffer.from(JSON.stringify(value), 'utf-8');
      response.writeHead(status, {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...(extra ?? {}),
      });
      response.end(payload);
    },
    beginStream(status, streamHeaders) {
      const outgoing = { ...streamHeaders };
      delete outgoing['connection'];
      delete outgoing['transfer-encoding'];
      response.writeHead(status, outgoing);
      return {
        write(chunk) {
          if (!response.writableEnded) response.write(Buffer.from(chunk));
        },
        end(trailers) {
          if (response.writableEnded) return;
          if (trailers) {
            try {
              response.stream.sendTrailers(trailers);
            } catch {
              // The peer may have gone already; the end below still applies.
            }
          }
          response.end();
        },
        get closed() {
          return response.writableEnded || response.stream.destroyed;
        },
        onClose(listener) {
          response.stream.on('close', listener);
        },
      };
    },
    destroy() {
      request.stream.destroy();
    },
  };
}

export { UPSTREAM_HEADER };
