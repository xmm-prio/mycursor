/**
 * Payload composition, detection and removal.
 *
 * Install and uninstall both depend on these three staying consistent with one
 * another. The stacking case matters most: a payload applied twice would
 * install two interception runtimes, and the guard that prevents it lives in
 * the strip-then-prepend sequence tested here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PAYLOAD_BEGIN,
  PAYLOAD_END,
  RUNTIME_VERSION,
  buildPayload,
  buildRendererPayload,
  hasPayload,
  hasStalePayload,
  stripPayload,
} from '@mycursor/interceptor';

const HOST = '/*! original bundle */\nmodule.exports = function cursor() { return 1; };\n';

function nodePayload(label = 'test') {
  return buildPayload({ processLabel: label, guardMarker: `__guard_${label}` });
}

test('a payload is prepended and the original follows verbatim', () => {
  const payload = nodePayload();
  const patched = payload + HOST;

  assert.ok(patched.startsWith(PAYLOAD_BEGIN));
  assert.ok(payload.includes(PAYLOAD_END));
  assert.equal(patched.slice(payload.length), HOST);
});

test('the payload records its version and label inside the marker comment', () => {
  const payload = nodePayload('agent-host');
  assert.ok(payload.startsWith(`${PAYLOAD_BEGIN} v${RUNTIME_VERSION} agent-host */`));
});

test('detection is guard-marker aware', () => {
  const patched = nodePayload('one') + HOST;
  assert.equal(hasPayload(patched), true);
  assert.equal(hasPayload(patched, '__guard_one'), true);
  assert.equal(hasPayload(patched, '__guard_two'), false);
  assert.equal(hasPayload(HOST), false);
});

test('an older payload version is detected as stale', () => {
  const patched = nodePayload() + HOST;
  assert.equal(hasStalePayload(patched, '__guard_test'), false);

  const aged = patched.replace(`v${RUNTIME_VERSION}`, 'v0');
  assert.equal(hasStalePayload(aged, '__guard_test'), true);
});

test('stripping restores the original exactly', () => {
  const patched = nodePayload() + HOST;
  const { source, removed } = stripPayload(patched);
  assert.equal(removed, 1);
  assert.equal(source, HOST);
});

test('stripping removes every block, so a payload cannot stack', () => {
  const doubled = nodePayload('a') + nodePayload('b') + HOST;
  const { source, removed } = stripPayload(doubled);
  assert.equal(removed, 2);
  assert.equal(source, HOST);

  // This is the sequence `applyPlan` uses for a refresh.
  const refreshed = nodePayload('a') + stripPayload(doubled).source;
  assert.equal(refreshed.split(PAYLOAD_BEGIN).length - 1, 1);
});

test('stripping a file that was never patched changes nothing', () => {
  const { source, removed } = stripPayload(HOST);
  assert.equal(removed, 0);
  assert.equal(source, HOST);
});

test('the renderer payload carries its route table and guard marker', () => {
  const payload = buildRendererPayload({
    processLabel: 'renderer-desktop',
    guardMarker: '__guard_renderer',
    server: { host: '127.0.0.1', port: 39841 },
    byokMode: true,
    hostPatterns: ['^api2\\.cursor\\.sh$'],
    redirect: ['aiserver.v1.AuthService'],
  });

  assert.ok(payload.startsWith(PAYLOAD_BEGIN));
  assert.ok(payload.includes('__guard_renderer'));
  // The renderer has no filesystem, so configuration travels inside the payload.
  assert.ok(payload.includes('aiserver.v1.AuthService'));
  assert.ok(payload.includes('39841'));
  // It must not pull in Node built-ins, which do not exist in that host.
  assert.equal(payload.includes('require("node:fs")'), false);
});

test('the node payload does require Node built-ins, as its host provides them', () => {
  const payload = nodePayload();
  assert.ok(payload.includes('require("node:http")'));
  assert.ok(payload.includes('require("node:tls")'));
});
