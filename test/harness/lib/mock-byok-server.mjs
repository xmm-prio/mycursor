/**
 * Stand-in for the local BYOK server.
 *
 * It implements exactly the contract the interception layers depend on, and
 * nothing else:
 *
 *  - the health endpoint, with the identity marker the uplink probe requires,
 *    so a foreign listener on the port cannot be mistaken for us;
 *  - plaintext HTTP/1.1 *and* cleartext HTTP/2 on one port;
 *  - TLS with ALPN on a second port, for the socket-level layer;
 *  - an echo of how the request arrived, so the matrix can assert not just
 *    *that* a request was captured but that the upstream identity survived —
 *    via `Host`, `:authority`, SNI, or the provenance header.
 *
 * Keeping it separate from the real server is deliberate: the matrix is then
 * testing the interceptor alone, with no chance of a server bug masking an
 * interception bug or vice versa.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createH2Server } from 'node:http2';
import { createServer as createTlsServer } from 'node:tls';

import { createProtocolMultiplexer, handTlsSocketByAlpn } from '@mycursor/core/net';
import { generateSelfSigned } from '@mycursor/core/tls';

const MARKER = 'byok';
const HEALTH_PATH = '/__mycursor/health';

export async function startMockByokServer({ host = '127.0.0.1', port = 0, tlsPort = 0 } = {}) {
  const material = generateSelfSigned({
    commonName: 'mycursor test listener',
    dnsNames: ['api2.cursor.test', 'localhost', '*.cursor.test'],
    ipAddresses: ['127.0.0.1'],
  });

  const requests = [];

  const record = (entry) => {
    if (entry.path !== HEALTH_PATH) requests.push(entry);
    return entry;
  };

  const payload = (entry) => JSON.stringify({ served: MARKER, ...entry });

  const handleHttp1 = (transport) => (request, response) => {
    if (request.url === HEALTH_PATH) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'mycursor' }));
      return;
    }
    const entry = record({
      transport,
      protocol: 'http/1.1',
      path: request.url,
      host: request.headers.host ?? null,
      sni: request.socket.servername ?? null,
      upstreamHeader: request.headers['x-mycursor-upstream'] ?? null,
      originHeader: request.headers['x-mycursor-origin'] ?? null,
      upgrade: request.headers.upgrade ?? null,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(payload(entry));
  };

  const handleUpgrade = (transport) => (request, socket) => {
    record({
      transport,
      protocol: 'ws-upgrade',
      path: request.url,
      host: request.headers.host ?? null,
      upgrade: request.headers.upgrade ?? null,
    });
    // Refusing the upgrade is the configured `downgrade` policy: the client
    // falls back to its SSE transport without any bundle surgery.
    socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
    socket.end();
  };

  const handleStream = (transport) => (stream, headers) => {
    const path = headers[':path'];
    if (path === HEALTH_PATH) {
      stream.respond({ ':status': 200, 'content-type': 'application/json' });
      stream.end(JSON.stringify({ ok: true, service: 'mycursor' }));
      return;
    }
    const entry = record({
      transport,
      protocol: 'h2',
      path,
      host: headers[':authority'] ?? null,
      scheme: headers[':scheme'] ?? null,
      sni: stream.session?.socket?.servername ?? null,
      upstreamHeader: headers['x-mycursor-upstream'] ?? null,
      originHeader: headers['x-mycursor-origin'] ?? null,
    });
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(payload(entry));
  };

  const plainHttp1 = createHttpServer(handleHttp1('plain'));
  plainHttp1.on('upgrade', handleUpgrade('plain'));
  const plainHttp2 = createH2Server();
  plainHttp2.on('stream', handleStream('plain'));
  const plain = createProtocolMultiplexer({ http1: plainHttp1, http2: plainHttp2 });

  const secureHttp1 = createHttpServer(handleHttp1('tls'));
  secureHttp1.on('upgrade', handleUpgrade('tls'));
  const secureHttp2 = createH2Server();
  secureHttp2.on('stream', handleStream('tls'));
  const secure = createTlsServer(
    { key: material.key, cert: material.cert, ALPNProtocols: ['h2', 'http/1.1'] },
    (socket) => handTlsSocketByAlpn(socket, { http1: secureHttp1, http2: secureHttp2 }),
  );

  await new Promise((resolve, reject) => {
    plain.once('error', reject);
    plain.listen(port, host, resolve);
  });
  await new Promise((resolve, reject) => {
    secure.once('error', reject);
    secure.listen(tlsPort, host, resolve);
  });

  return {
    marker: MARKER,
    host,
    port: plain.address().port,
    tlsPort: secure.address().port,
    requests,
    async close() {
      await new Promise((resolve) => plain.close(resolve));
      await new Promise((resolve) => secure.close(resolve));
      plainHttp1.close();
      plainHttp2.close();
      secureHttp1.close();
      secureHttp2.close();
    },
  };
}

export { HEALTH_PATH };
