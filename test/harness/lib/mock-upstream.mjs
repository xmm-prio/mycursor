/**
 * Stand-in for Cursor's official API.
 *
 * Anything that reaches this server was *not* intercepted, which makes it the
 * control half of the matrix: passthrough assertions are only meaningful if
 * there is a distinguishable destination to pass through to.
 *
 * It answers over TLS with ALPN for both `h2` and `http/1.1`, because the
 * fail-open paths negotiate ALPN exactly as an uninstrumented Cursor would.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createH2Server } from 'node:http2';
import { createServer as createTlsServer } from 'node:tls';

import { handTlsSocketByAlpn } from '@mycursor/core/net';
import { generateSelfSigned } from '@mycursor/core/tls';

const MARKER = 'upstream';

function describe(request, extra = {}) {
  return JSON.stringify({
    served: MARKER,
    path: request.url ?? request.headers?.[':path'] ?? null,
    host: request.headers?.host ?? request.headers?.[':authority'] ?? null,
    ...extra,
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.host]
 * @param {number} [options.port]
 * @param {Map<string, {status?: number, contentType?: string, body: Uint8Array}>} [options.responses]
 *   Per-path canned responses, so a test can make the official API return a
 *   realistic protobuf body instead of the JSON marker.
 */
export async function startMockUpstream({ host = '127.0.0.1', port = 0, responses } = {}) {
  const material = generateSelfSigned({
    commonName: 'mock upstream',
    dnsNames: ['api2.cursor.test', 'localhost'],
    ipAddresses: ['127.0.0.1'],
  });

  const requests = [];

  const canned = responses ?? new Map();

  const http1 = createHttpServer((request, response) => {
    requests.push({ protocol: 'http/1.1', path: request.url, host: request.headers.host });

    const override = canned.get((request.url ?? '').split('?')[0]);
    if (override) {
      response.writeHead(override.status ?? 200, {
        'content-type': override.contentType ?? 'application/proto',
        'content-length': String(override.body.length),
      });
      response.end(Buffer.from(override.body));
      return;
    }

    if (request.headers.upgrade) {
      // Cursor's agent WebSocket endpoint; the official API accepts the upgrade.
      response.writeHead(101, { Upgrade: 'websocket', Connection: 'Upgrade' });
      response.end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(describe(request, { protocol: 'http/1.1' }));
  });
  http1.on('upgrade', (request, socket) => {
    requests.push({ protocol: 'ws', path: request.url, host: request.headers.host });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });

  const http2 = createH2Server();
  http2.on('stream', (stream, headers) => {
    requests.push({ protocol: 'h2', path: headers[':path'], host: headers[':authority'] });
    const override = canned.get(String(headers[':path'] ?? '').split('?')[0]);
    if (override) {
      stream.respond({
        ':status': override.status ?? 200,
        'content-type': override.contentType ?? 'application/proto',
      });
      stream.end(Buffer.from(override.body));
      return;
    }
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end(JSON.stringify({ served: MARKER, path: headers[':path'], host: headers[':authority'], protocol: 'h2' }));
  });

  const tls = createTlsServer(
    { key: material.key, cert: material.cert, ALPNProtocols: ['h2', 'http/1.1'] },
    (socket) => handTlsSocketByAlpn(socket, { http1, http2 }),
  );

  await new Promise((resolve, reject) => {
    tls.once('error', reject);
    tls.listen(port, host, resolve);
  });

  return {
    marker: MARKER,
    host,
    port: tls.address().port,
    requests,
    async close() {
      await new Promise((resolve) => tls.close(resolve));
      http1.close();
      http2.close();
    },
  };
}
