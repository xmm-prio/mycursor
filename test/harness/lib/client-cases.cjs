/**
 * The client shapes a patched Cursor process actually uses.
 *
 * This file is concatenated after the interception payload into a single
 * CommonJS module, which is exactly how the payload reaches Cursor's own
 * bundles — same module scope, same `require`, same evaluation order. Testing
 * against a faithful host is the point: a harness that imported the runtime as
 * a library would not exercise injection at all.
 *
 * Each case resolves to the JSON body its request received. The mock servers
 * label their responses, so the caller can tell which one answered.
 */

'use strict';

const http = require('http');
const https = require('https');
const http2 = require('http2');
const tls = require('tls');

const config = JSON.parse(process.env.HARNESS_CASE_CONFIG);
const { upstreamHost, upstreamPort, matchedPath, unmatchedPath, upgradePath } = config;

const origin = `https://${upstreamHost}:${upstreamPort}`;

function readJson(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error(`non-JSON response: ${text.slice(0, 200)}`));
      }
    });
    stream.on('error', reject);
  });
}

function requestViaNode(method, path, { useGet = false } = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: upstreamHost,
      port: upstreamPort,
      path,
      method,
      // The mock upstream presents a locally generated certificate; the child
      // process runs with verification disabled, this mirrors it explicitly.
      rejectUnauthorized: false,
    };
    const handler = (response) => readJson(response).then(resolve, reject);
    const request = useGet ? https.get(options, handler) : https.request(options, handler);
    request.on('error', reject);
    request.setTimeout(15_000, () => request.destroy(new Error('client timeout')));
    if (!useGet) request.end();
  });
}

function requestViaHttp2(path) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(origin, { rejectUnauthorized: false });
    session.on('error', reject);
    const stream = session.request({ ':path': path, ':method': 'GET' });
    stream.on('error', reject);
    readJson(stream).then(
      (value) => {
        session.close();
        resolve(value);
      },
      (error) => {
        session.close();
        reject(error);
      },
    );
  });
}

async function requestViaFetch(path) {
  const response = await fetch(`${origin}${path}`);
  return response.json();
}

/** Raw TLS plus a hand-written request line: the lowest-level client shape. */
function requestViaRawTls(path) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect(
      {
        host: upstreamHost,
        port: upstreamPort,
        servername: upstreamHost,
        rejectUnauthorized: false,
        ALPNProtocols: ['http/1.1'],
      },
      () => {
        socket.write(
          `GET ${path} HTTP/1.1\r\nHost: ${upstreamHost}:${upstreamPort}\r\nConnection: close\r\n\r\n`,
        );
      },
    );
    const chunks = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      // A hand-written request gets a hand-written parser: the body may be
      // chunked, so extract the JSON object rather than assuming it starts
      // right after the headers.
      const start = text.indexOf('{', text.indexOf('\r\n\r\n'));
      const end = text.lastIndexOf('}');
      try {
        resolve(JSON.parse(text.slice(start, end + 1)));
      } catch {
        reject(new Error(`non-JSON response: ${text.slice(0, 200)}`));
      }
    });
    socket.setTimeout(15_000, () => socket.destroy(new Error('client timeout')));
  });
}

/**
 * The agent WebSocket handshake, performed the way the `ws` package does it.
 *
 * A refused upgrade is the expected, healthy outcome under the `downgrade`
 * policy: it is what makes Cursor fall back to SSE without editing its bundle.
 */
function requestUpgrade(path) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: upstreamHost,
      port: upstreamPort,
      path,
      rejectUnauthorized: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': Buffer.from('mycursor-harness!').toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    });
    request.on('upgrade', (response) => {
      resolve({ served: 'upstream-upgrade', status: response.statusCode });
    });
    request.on('response', (response) => {
      readJson(response).then(
        (body) => resolve(body),
        () => resolve({ served: 'refused-upgrade', status: response.statusCode }),
      );
    });
    request.on('error', reject);
    request.setTimeout(15_000, () => request.destroy(new Error('client timeout')));
    request.end();
  });
}

const CASES = {
  'http1-matched': () => requestViaNode('GET', matchedPath),
  'http1-unmatched': () => requestViaNode('GET', unmatchedPath),
  'http1-get-matched': () => requestViaNode('GET', matchedPath, { useGet: true }),
  'http2-matched': () => requestViaHttp2(matchedPath),
  'http2-unmatched': () => requestViaHttp2(unmatchedPath),
  'fetch-matched': () => requestViaFetch(matchedPath),
  'fetch-unmatched': () => requestViaFetch(unmatchedPath),
  'raw-tls-matched': () => requestViaRawTls(matchedPath),
  'ws-upgrade-matched': () => requestUpgrade(upgradePath),
};

async function main() {
  const name = process.argv[2];
  const run = CASES[name];
  if (!run) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: `unknown case: ${name}` })}\n`);
    process.exit(2);
  }
  try {
    const body = await run();
    process.stdout.write(`${JSON.stringify({ ok: true, case: name, body })}\n`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, case: name, error: error && error.message })}\n`,
    );
    process.exit(1);
  }
}

void main();
