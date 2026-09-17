/**
 * Outbound HTTP for provider calls.
 *
 * Built on `node:https` rather than `fetch` for one reason: proxy support.
 * Node's `fetch` has no public way to route a request through an HTTP proxy,
 * and users behind a corporate proxy are exactly the ones most likely to need
 * a custom base URL in the first place. Owning the connection also makes the
 * CONNECT tunnel below possible without a dependency.
 *
 * Retries apply only to failures that happened before any body arrived.
 * Retrying mid-stream would duplicate text the caller has already emitted.
 */

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

import { ProviderError } from '../types.js';
import { resolveProxy } from './proxy.js';

export interface HttpCallOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: unknown;
  /** Overrides the proxy; without it the environment's is used. */
  proxyUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Attempts for a retryable failure before giving up. */
  retries?: number;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  stream: AsyncIterable<Uint8Array>;
}

/** Status codes worth retrying: rate limits and transient server faults. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

const DEFAULT_TIMEOUT_MS = 300_000;

export async function call(options: HttpCallOptions): Promise<HttpResponse> {
  const attempts = Math.max(1, (options.retries ?? 2) + 1);
  let lastError: ProviderError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await once(options);
      if (response.status >= 400) {
        const detail = await readAll(response.stream);
        const retryable = RETRYABLE_STATUS.has(response.status);
        lastError = new ProviderError(
          `upstream returned HTTP ${response.status}: ${truncate(detail, 400)}`,
          retryable,
          response.status,
        );
        if (!retryable || attempt === attempts) throw lastError;
        await backoff(attempt, response.headers['retry-after']);
        continue;
      }
      return response;
    } catch (error) {
      if (error instanceof ProviderError) {
        if (!error.retryable || attempt === attempts) throw error;
        lastError = error;
        await backoff(attempt, undefined);
        continue;
      }
      if ((error as Error).name === 'AbortError') throw error;
      lastError = new ProviderError(`upstream request failed: ${(error as Error).message}`, true);
      if (attempt === attempts) throw lastError;
      await backoff(attempt, undefined);
    }
  }

  throw lastError ?? new ProviderError('upstream request failed', false);
}

function once(options: HttpCallOptions): Promise<HttpResponse> {
  const target = new URL(options.url);
  const secure = target.protocol === 'https:';
  const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf-8');

  const headers: Record<string, string> = { ...options.headers };
  if (payload) {
    headers['content-type'] ??= 'application/json';
    headers['content-length'] = String(payload.length);
  }

  return new Promise<HttpResponse>((resolve, reject) => {
    const issue = (socket?: Socket): void => {
      const requestFn = secure ? httpsRequest : httpRequest;
      const request = requestFn(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (secure ? 443 : 80),
          path: `${target.pathname}${target.search}`,
          method: options.method ?? 'POST',
          headers: { host: target.host, ...headers },
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          // A tunnelled socket replaces the connection entirely; without an
          // agent Node would otherwise open its own.
          ...(socket ? { agent: undefined, createConnection: () => socket } : {}),
        },
        (response: IncomingMessage) => {
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
          }
          resolve({
            status: response.statusCode ?? 0,
            headers: responseHeaders,
            stream: response as unknown as AsyncIterable<Uint8Array>,
          });
        },
      );

      request.on('timeout', () => request.destroy(new Error('upstream timed out')));
      request.on('error', reject);
      options.signal?.addEventListener('abort', () => request.destroy(abortError()), { once: true });
      if (payload) request.write(payload);
      request.end();
    };

    // Falls back to the environment, so a machine already configured for a
    // corporate proxy works without the proxy field being filled in too.
    const proxyUrl = resolveProxy(options.url, options.proxyUrl);
    if (!proxyUrl) {
      issue();
      return;
    }

    openTunnel(proxyUrl, target, secure).then(issue, reject);
  });
}

/**
 * Opens a connection through an HTTP proxy.
 *
 * HTTPS needs a CONNECT tunnel, and the TLS handshake then runs inside it so
 * the proxy never sees the request. Plain HTTP just uses the proxy as the
 * next hop.
 */
async function openTunnel(proxyUrl: string, target: URL, secure: boolean): Promise<Socket> {
  const proxy = new URL(proxyUrl);
  const proxyPort = Number.parseInt(proxy.port || (proxy.protocol === 'https:' ? '443' : '80'), 10);
  const port = target.port || (secure ? '443' : '80');

  if (!secure) {
    return netConnect({ host: proxy.hostname, port: proxyPort });
  }

  const raw = await new Promise<Socket>((resolve, reject) => {
    const socket = netConnect({ host: proxy.hostname, port: proxyPort });
    const authority = `${target.hostname}:${port}`;
    const credentials =
      proxy.username || proxy.password
        ? `Proxy-Authorization: Basic ${Buffer.from(
            `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
          ).toString('base64')}\r\n`
        : '';

    socket.once('error', reject);
    socket.once('connect', () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credentials}\r\n`);
    });

    let banner = '';
    const onData = (chunk: Buffer): void => {
      banner += chunk.toString('latin1');
      const end = banner.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const statusLine = banner.slice(0, banner.indexOf('\r\n'));
      if (!/ 2\d\d /.test(statusLine)) {
        socket.destroy();
        reject(new ProviderError(`proxy refused CONNECT: ${statusLine}`, false));
        return;
      }
      // Anything the proxy sent past the blank line belongs to the tunnel.
      const extra = banner.slice(end + 4);
      if (extra.length > 0) socket.unshift(Buffer.from(extra, 'latin1'));
      resolve(socket);
    };
    socket.on('data', onData);
  });

  return tlsConnect({ socket: raw, servername: target.hostname }) as unknown as Socket;
}

export async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf-8');
}

export async function readJson<T>(stream: AsyncIterable<Uint8Array>): Promise<T> {
  const text = await readAll(stream);
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ProviderError(
      `upstream returned a non-JSON body: ${truncate(text, 200)} (${(error as Error).message})`,
      false,
    );
  }
}

function abortError(): Error {
  const error = new Error('request aborted');
  error.name = 'AbortError';
  return error;
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function backoff(attempt: number, retryAfter: string | undefined): Promise<void> {
  const hinted = retryAfter ? Number.parseFloat(retryAfter) * 1_000 : Number.NaN;
  const delay = Number.isFinite(hinted) ? hinted : Math.min(8_000, 2 ** attempt * 250);
  return new Promise((resolve) => setTimeout(resolve, delay));
}
