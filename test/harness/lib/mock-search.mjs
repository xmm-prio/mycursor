/**
 * A stand-in for the six web search services.
 *
 * It runs as an HTTP proxy that terminates the CONNECT tunnel itself, which
 * lets the real backend code run unmodified: it builds the real `api.exa.ai`
 * URL, sets the real auth header, and parses a real HTTP response. Only the
 * far end is ours.
 *
 * Going through `proxyUrl` rather than DNS also keeps the verification off
 * privileged ports and exercises the proxy path the toolkit ships.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';

import { loadOrCreateCertificate } from '@mycursor/core/tls';

/** Canned bodies keyed by `host+pathname`, in each service's own shape. */
const RESPONSES = {
  'html.duckduckgo.com/html/': () => ({
    contentType: 'text/html',
    body: [
      '<div class="result">',
      '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ffs.html">Node.js fs &amp; docs</a>',
      '<a class="result__snippet">The <b>fs</b> module enables file system access.</a>',
      '</div>',
      '<div class="result">',
      '<a class="result__a" href="https://example.com/second">Second result</a>',
      '<a class="result__snippet">Another snippet.</a>',
      '</div>',
    ].join('\n'),
  }),

  'api.exa.ai/search': () => ({
    body: {
      results: [
        { title: 'Exa hit', url: 'https://example.com/exa', text: 'Exa extract.' },
        { title: 'Exa second', url: 'https://example.com/exa2', summary: 'Exa summary.' },
      ],
    },
  }),

  'api.tavily.com/search': () => ({
    body: {
      results: [{ title: 'Tavily hit', url: 'https://example.com/tavily', content: 'Tavily extract.' }],
    },
  }),

  'api.search.brave.com/res/v1/web/search': () => ({
    body: {
      web: {
        results: [
          { title: 'Brave hit', url: 'https://example.com/brave', description: 'Brave <strong>extract</strong>.' },
        ],
      },
    },
  }),

  's.jina.ai': () => ({
    body: { data: [{ title: 'Jina hit', url: 'https://example.com/jina', description: 'Jina extract.' }] },
  }),

  'r.jina.ai': () => ({ contentType: 'text/plain', body: '# Jina read\n\nThe page as Markdown.' }),

  'api.firecrawl.dev/v1/search': () => ({
    body: {
      data: [{ title: 'Firecrawl hit', url: 'https://example.com/fire', description: 'Firecrawl extract.' }],
    },
  }),

  'api.firecrawl.dev/v1/scrape': () => ({
    body: { data: { markdown: '# Firecrawl read\n\nThe page as Markdown.' } },
  }),
};

/**
 * Starts the mock.
 *
 * @param {{ tlsDirectory: string, fail?: Set<string> }} options
 *   `fail` names hosts that should answer 500, for the degradation checks.
 */
export async function startMockSearch(options) {
  /** Every request the backends made, for assertions about headers and bodies. */
  const requests = [];
  const failing = options.fail ?? new Set();

  const material = loadOrCreateCertificate(options.tlsDirectory, {
    commonName: 'mock search',
    dnsNames: [
      'html.duckduckgo.com',
      'api.exa.ai',
      'api.tavily.com',
      'api.search.brave.com',
      's.jina.ai',
      'r.jina.ai',
      'api.firecrawl.dev',
    ],
    ipAddresses: ['127.0.0.1'],
  });

  const tls = createTlsServer({ key: material.key, cert: material.cert });
  tls.on('secureConnection', (socket) => handleHttp(socket));

  /** Minimal HTTP/1.1 reader: these are small single-shot requests. */
  const handleHttp = (socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;

      const head = buffer.subarray(0, headerEnd).toString('utf8');
      const [requestLine, ...headerLines] = head.split('\r\n');
      const headers = {};
      for (const line of headerLines) {
        const index = line.indexOf(':');
        if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
      }

      const declared = Number.parseInt(headers['content-length'] ?? '0', 10) || 0;
      const body = buffer.subarray(headerEnd + 4);
      if (body.length < declared) return;

      const [method, target] = requestLine.split(' ');
      const url = new URL(target, `https://${headers.host}`);
      let parsedBody = null;
      if (declared > 0) {
        try {
          parsedBody = JSON.parse(body.subarray(0, declared).toString('utf8'));
        } catch {
          parsedBody = body.subarray(0, declared).toString('utf8');
        }
      }

      requests.push({
        method,
        host: url.hostname,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body: parsedBody,
      });

      socket.end(render(url, headers, failing));
    });
    socket.on('error', () => {});
  };

  const proxy = createHttpServer();
  // The backends all speak https, so every call arrives as CONNECT.
  proxy.on('connect', (_request, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    tls.emit('connection', socket);
  });
  proxy.on('clientError', (_error, socket) => socket.destroy());

  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const { port } = proxy.address();

  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        tls.close();
        proxy.close(resolve);
      }),
  };
}

function render(url, headers, failing) {
  if (failing.has(url.hostname)) {
    return httpResponse(500, 'application/json', JSON.stringify({ error: 'the service is unwell' }));
  }

  // Jina puts the query and the target URL in the path, so it matches by host.
  const key = url.hostname.startsWith('s.jina.ai') || url.hostname.startsWith('r.jina.ai')
    ? url.hostname
    : `${url.hostname}${url.pathname}`;

  const responder = RESPONSES[key];
  if (!responder) return httpResponse(404, 'application/json', JSON.stringify({ error: `no mock for ${key}` }));

  const { contentType = 'application/json', body } = responder(headers);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return httpResponse(200, contentType, text);
}

function httpResponse(status, contentType, body) {
  const payload = Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(
      [
        `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Error'}`,
        `content-type: ${contentType}`,
        `content-length: ${payload.length}`,
        'connection: close',
        '',
        '',
      ].join('\r\n'),
      'utf8',
    ),
    payload,
  ]);
}
