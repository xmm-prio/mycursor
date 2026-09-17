/**
 * Serving HTTP/1.1 and cleartext HTTP/2 on one port.
 *
 * The interception layers send both to the same place: the HTTP/1.1 layer
 * redirects ordinary requests, while the HTTP/2 layer points whole ConnectRPC
 * sessions at the same port. Node has no server that accepts both, because
 * without TLS there is no ALPN to negotiate with.
 *
 * The connection preface solves it. An HTTP/2 client always opens with the
 * fixed 24-byte string below, so peeking at the first bytes identifies the
 * protocol unambiguously before a single byte is consumed.
 */

import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import type { Http2Server } from 'node:http2';
import type { Server as HttpServer } from 'node:http';

const HTTP2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'ascii');

/** Longest prefix needed to tell the two protocols apart. */
const PEEK_BYTES = HTTP2_PREFACE.length;

export interface MultiplexerOptions {
  http1: HttpServer;
  http2: Http2Server;
  /** Milliseconds to wait for the first bytes before assuming HTTP/1.1. */
  sniffTimeoutMs?: number;
  onDiagnostic?: (message: string) => void;
}

/**
 * Wraps two servers behind one listener.
 *
 * The returned server is a plain `net.Server`: call `listen` on it as usual.
 * Neither inner server should be listening itself — they only receive sockets.
 */
export function createProtocolMultiplexer(options: MultiplexerOptions): NetServer {
  const sniffTimeoutMs = options.sniffTimeoutMs ?? 5_000;
  const onDiagnostic = options.onDiagnostic ?? (() => {});

  return createNetServer((socket) => {
    let buffered: Buffer = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      // A client that sends nothing is treated as HTTP/1.1, whose parser is
      // the more forgiving of the two.
      hand(options.http1);
    }, sniffTimeoutMs);
    timer.unref?.();

    const hand = (target: HttpServer | Http2Server): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);

      // Order matters. Reading put the socket in flowing mode, so the sniffed
      // bytes must be pushed back while it is paused — otherwise `unshift`
      // re-emits them before the inner server has attached its parser and the
      // request is silently lost. Resuming is deferred by a tick for the same
      // reason: the parser has to be in place first.
      socket.pause();
      if (buffered.length > 0) socket.unshift(buffered);
      target.emit('connection', socket);
      process.nextTick(() => socket.resume());
    };

    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      const comparable = Math.min(buffered.length, PEEK_BYTES);
      if (!buffered.subarray(0, comparable).equals(HTTP2_PREFACE.subarray(0, comparable))) {
        hand(options.http1);
        return;
      }
      if (buffered.length >= PEEK_BYTES) hand(options.http2);
      // Otherwise the prefix still matches; wait for more bytes.
    };

    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onDiagnostic(`multiplexed connection failed before protocol detection: ${error.message}`);
      socket.destroy();
    };

    socket.on('data', onData);
    socket.on('error', onError);
  });
}

/**
 * Routes an already-negotiated TLS socket by its ALPN protocol.
 *
 * The socket layer forwards the client's `ALPNProtocols` untouched, so the TLS
 * listener learns the protocol from the handshake and does not need to sniff.
 */
export function handTlsSocketByAlpn(
  socket: Socket & { alpnProtocol?: string | false | null },
  servers: { http1: HttpServer; http2: Http2Server },
): void {
  // A client that sent no ALPN extension gets HTTP/1.1, which is the correct
  // default and the more forgiving parser of the two.
  if (socket.alpnProtocol === 'h2') servers.http2.emit('connection', socket);
  else servers.http1.emit('connection', socket);
}

export { HTTP2_PREFACE };
