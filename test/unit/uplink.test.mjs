/**
 * Deciding how long to hold a request for a server that may be starting.
 *
 * The hold exists for one situation: the server is coming up and the first
 * request should wait rather than fail. It must not be paid by every request
 * when there is no server at all — with Cursor patched and the server unable
 * to start, that adds the full budget to every call the IDE makes, which is
 * indistinguishable from a hang. Measured before this was fixed: three
 * consecutive requests took 19.9 seconds each.
 *
 * `cached()` already documented the distinction — `undefined` means "not
 * probed, worth waiting", `null` means "probed, nothing there" — and
 * `waitForTarget` collapsed the two with a truthiness check.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDefaultConfig } from '@mycursor/core/config';

import { UplinkResolver } from '../../packages/interceptor/dist/runtime/uplink.js';

/**
 * A resolver whose probe outcome is scripted, so the timing under test is the
 * resolver's own and not a real socket's.
 */
function makeResolver({ healthyAfter = Infinity, budgetMs = 400, ttlSeconds = 30 } = {}) {
  const config = createDefaultConfig();
  config.uplink.mode = 'local';
  config.uplink.probeTtlSeconds = ttlSeconds;
  config.interception.readiness.maxWaitMs = budgetMs;
  config.interception.readiness.retryDelayMs = 20;

  let probes = 0;
  const resolver = new UplinkResolver({
    originals: { direct: {}, outer: {} },
    readConfig: () => config,
    onDiagnostic: () => {},
  });

  // The probe is the seam: replacing it keeps the test off the network.
  resolver.probe = async () => {
    probes += 1;
    return probes >= healthyAfter;
  };

  return { resolver, budgetMs, probeCount: () => probes };
}

test('a request waits while the server is still starting', async () => {
  const { resolver, budgetMs } = makeResolver({ healthyAfter: 3 });
  const started = Date.now();
  const target = await resolver.waitForTarget(budgetMs);
  assert.ok(target, 'should have found the server once it came up');
  assert.ok(Date.now() - started < budgetMs, 'should return as soon as it is healthy');
});

test('only the first request pays the wait when no server appears', async () => {
  const { resolver, budgetMs } = makeResolver();

  const first = Date.now();
  assert.equal(await resolver.waitForTarget(budgetMs), null);
  const firstElapsed = Date.now() - first;
  assert.ok(firstElapsed >= budgetMs * 0.5, `first request should wait, took ${firstElapsed}ms`);

  // This is the regression: each of these used to wait the full budget too.
  for (let i = 0; i < 3; i += 1) {
    const started = Date.now();
    assert.equal(await resolver.waitForTarget(budgetMs), null);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < budgetMs / 4, `follow-up ${i} should pass through, took ${elapsed}ms`);
  }
});

test('waiting resumes once the probe TTL lapses', async () => {
  const { resolver, budgetMs, probeCount } = makeResolver({ ttlSeconds: 0 });

  assert.equal(await resolver.waitForTarget(budgetMs), null);
  const after = probeCount();
  // With the TTL lapsed the resolver must look again rather than assume.
  assert.equal(await resolver.waitForTarget(budgetMs), null);
  assert.ok(probeCount() > after, 'should have probed again after the TTL lapsed');
});

test('a server that appears later is picked up rather than written off', async () => {
  const { resolver, budgetMs } = makeResolver();
  assert.equal(await resolver.waitForTarget(budgetMs), null);

  // The server starts. Passing through forever would strand the user on the
  // official API until the window was reloaded.
  resolver.probe = async () => true;
  resolver.invalidate();
  assert.ok(await resolver.waitForTarget(budgetMs));
});
