/**
 * Configuration normalisation and last-known-good retention.
 *
 * The retention behaviour is the one worth guarding: a half-saved document
 * must not silently switch interception off, because the failure mode is a
 * prompt that quietly goes to the wrong provider.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  ConfigStore,
  createDefaultConfig,
  loadConfigFrom,
  normaliseConfig,
  resolveConfigRoot,
  saveConfigTo,
} from '@mycursor/core/config';

function workspace() {
  return mkdtempSync(join(tmpdir(), 'mycursor-config-'));
}

test('normalise fills in an empty document from defaults', () => {
  const { config, warnings } = normaliseConfig({});
  assert.deepEqual(config, createDefaultConfig());
  assert.deepEqual(warnings, []);
});

test('normalise replaces unusable values and says so', () => {
  const { config, warnings } = normaliseConfig({
    byokMode: 'maybe',
    server: { host: '', port: 'not-a-port' },
    interception: { readiness: { strategy: 'panic', maxWaitMs: -5 }, hostPatterns: [] },
    upstream: { policy: 'explode' },
    redirect: ['ok.Service', 7],
  });

  const defaults = createDefaultConfig();
  assert.equal(config.byokMode, defaults.byokMode);
  assert.equal(config.server.host, defaults.server.host);
  assert.equal(config.server.port, defaults.server.port);
  assert.equal(config.interception.readiness.strategy, defaults.interception.readiness.strategy);
  assert.equal(config.upstream.policy, defaults.upstream.policy);
  // An empty host pattern list would capture nothing, so defaults are restored.
  assert.deepEqual(config.interception.hostPatterns, defaults.interception.hostPatterns);
  assert.deepEqual(config.redirect, ['ok.Service']);
  assert.ok(warnings.length >= 5, `expected several warnings, got ${warnings.length}`);
});

test('normalise accepts the 0/1 encoding older documents use for byokMode', () => {
  assert.equal(normaliseConfig({ byokMode: 1 }).config.byokMode, true);
  assert.equal(normaliseConfig({ byokMode: 0 }).config.byokMode, false);
});

test('a TLS port that collides with the plaintext port is moved aside', () => {
  const { config, warnings } = normaliseConfig({ server: { port: 40000, tlsPort: 40000 } });
  assert.equal(config.server.port, 40000);
  assert.equal(config.server.tlsPort, 40001);
  assert.ok(warnings.some((warning) => warning.includes('tlsPort')));
});

test('load distinguishes an absent document from an invalid one', () => {
  const root = workspace();
  const path = join(root, 'config.json');
  assert.equal(loadConfigFrom(path).status, 'absent');

  writeFileSync(path, '{ this is not json');
  assert.equal(loadConfigFrom(path).status, 'invalid');

  saveConfigTo(path, createDefaultConfig());
  assert.equal(loadConfigFrom(path).status, 'loaded');
});

test('the store keeps the last good revision when the document becomes invalid', () => {
  const root = workspace();
  const path = join(root, 'config.json');
  const first = createDefaultConfig();
  first.redirect = ['aiserver.v1.AuthService'];
  saveConfigTo(path, first);

  const diagnostics = [];
  const store = ConfigStore.open({ path, onDiagnostic: (message) => diagnostics.push(message) });
  try {
    assert.equal(store.current().router.snapshot().rules, 1);
    const firstRevision = store.current().revision;

    // Simulate an editor mid-save.
    writeFileSync(path, '{ "redirect": [');
    const outcome = store.reload();

    assert.equal(outcome.changed, false, 'an invalid document must not be published');
    assert.equal(store.current().revision, firstRevision, 'the revision must not advance');
    assert.equal(store.current().router.snapshot().rules, 1, 'routing must keep working');
    assert.ok(diagnostics.some((message) => message.includes('last-known-good')));

    // A valid save is published normally.
    const second = createDefaultConfig();
    second.redirect = ['aiserver.v1.AuthService', 'aiserver.v1.HealthService'];
    saveConfigTo(path, second);
    assert.equal(store.reload().changed, true);
    assert.equal(store.current().router.snapshot().rules, 2);
  } finally {
    store.close();
  }
});

test('the store notifies listeners on a published revision only', () => {
  const root = workspace();
  const path = join(root, 'config.json');
  saveConfigTo(path, createDefaultConfig());

  const store = ConfigStore.open({ path });
  try {
    let notifications = 0;
    store.onChange(() => {
      notifications += 1;
    });

    writeFileSync(path, 'not json at all');
    store.reload();
    assert.equal(notifications, 0);

    saveConfigTo(path, createDefaultConfig());
    store.reload();
    assert.equal(notifications, 1);
  } finally {
    store.close();
  }
});

test('the configuration root honours MYCURSOR_HOME', () => {
  assert.equal(resolveConfigRoot({ MYCURSOR_HOME: '/tmp/elsewhere' }), '/tmp/elsewhere');
  assert.ok(resolveConfigRoot({}).endsWith('.mycursor'));
});
