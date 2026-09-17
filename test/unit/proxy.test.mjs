/**
 * Choosing a proxy for an outbound call.
 *
 * On a network that only reaches the internet through a proxy, ignoring the
 * environment means every provider call and every web search fails by timing
 * out — which reads as "the service is down" rather than "the request never
 * left the network". Measured on such a machine: a DuckDuckGo query went
 * from a 40 second timeout to 851 ms once the environment was honoured.
 *
 * The loopback rule matters just as much in the other direction. The local
 * BYOK server, the mock provider and the mock upstream all live on
 * 127.0.0.1, and sending that traffic to a corporate proxy would break every
 * local setup on a machine that happens to have one configured.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveProxy } from '@mycursor/providers';

const proxied = { HTTPS_PROXY: 'http://proxy:8080', HTTP_PROXY: 'http://proxy:8081' };

test('an explicitly configured proxy wins over the environment', () => {
  assert.equal(
    resolveProxy('https://api.openai.com/v1', 'http://chosen:3128', proxied),
    'http://chosen:3128',
  );
});

test('the environment is used when nothing is configured', () => {
  assert.equal(resolveProxy('https://api.openai.com/v1', undefined, proxied), 'http://proxy:8080');
  assert.equal(resolveProxy('http://example.com', undefined, proxied), 'http://proxy:8081');
});

test('lowercase and ALL_PROXY forms are read too', () => {
  assert.equal(
    resolveProxy('https://example.com', undefined, { https_proxy: 'http://lower:8080' }),
    'http://lower:8080',
  );
  assert.equal(
    resolveProxy('https://example.com', undefined, { ALL_PROXY: 'http://all:8080' }),
    'http://all:8080',
  );
});

test('loopback is never proxied, however the environment is set', () => {
  for (const url of [
    'http://127.0.0.1:39841/v1/models',
    'http://localhost:39841/health',
    'https://127.0.0.42:8443/x',
    'http://[::1]:39841/x',
  ]) {
    assert.equal(resolveProxy(url, undefined, proxied), undefined, url);
  }
});

test('an explicit proxy still applies to loopback, since it was asked for', () => {
  assert.equal(
    resolveProxy('http://127.0.0.1:39841/x', 'http://debug:8888', proxied),
    'http://debug:8888',
  );
});

test('NO_PROXY exempts a host and its subdomains', () => {
  const env = { ...proxied, NO_PROXY: 'internal.example.com, .corp' };
  assert.equal(resolveProxy('https://internal.example.com/x', undefined, env), undefined);
  assert.equal(resolveProxy('https://api.internal.example.com/x', undefined, env), undefined);
  assert.equal(resolveProxy('https://host.corp/x', undefined, env), undefined);
  // A host that merely shares a suffix string is not a subdomain.
  assert.equal(resolveProxy('https://notinternal.example.com/x', undefined, env), 'http://proxy:8080');
  assert.equal(resolveProxy('https://api.openai.com/x', undefined, env), 'http://proxy:8080');
});

test('NO_PROXY of "*" disables proxying entirely', () => {
  assert.equal(resolveProxy('https://api.openai.com/x', undefined, { ...proxied, NO_PROXY: '*' }), undefined);
});

test('no proxy is used when the environment names none', () => {
  assert.equal(resolveProxy('https://api.openai.com/x', undefined, {}), undefined);
  assert.equal(resolveProxy('https://api.openai.com/x', undefined, { HTTPS_PROXY: '  ' }), undefined);
});

test('a malformed URL yields no proxy rather than throwing', () => {
  assert.equal(resolveProxy('not a url', undefined, proxied), undefined);
});
