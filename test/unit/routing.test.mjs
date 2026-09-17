/**
 * Route grammar and matching.
 *
 * These are the decisions every intercepted request passes through, so the
 * cases below are the ones that would change behaviour if they regressed:
 * which rule kinds exist, what a malformed rule does, and — most importantly —
 * that an unclaimed path is passed through rather than captured.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  HostMatcher,
  RequestRouter,
  RouteTable,
  normalisePath,
  parseRule,
  splitRpcPath,
} from '@mycursor/core/routing';
import { DEFAULT_HOST_PATTERNS, createDefaultConfig } from '@mycursor/core/config';

test('parseRule recognises each rule kind', () => {
  assert.deepEqual(parseRule('aiserver.v1.AuthService'), {
    kind: 'service',
    value: 'aiserver.v1.AuthService',
    prefix: false,
    source: 'aiserver.v1.AuthService',
  });
  assert.equal(parseRule('aiserver.v1.AiService/AvailableModels')?.kind, 'method');
  assert.equal(parseRule('REST:/auth/poll')?.kind, 'rest');
  assert.equal(parseRule('REST:/auth/*')?.prefix, true);
});

test('parseRule rejects entries that cannot match anything', () => {
  // A bare word has no package qualifier, so it can never be a service name.
  assert.equal(parseRule('nonsense'), null);
  assert.equal(parseRule(''), null);
  assert.equal(parseRule('   '), null);
  assert.equal(parseRule('# a comment'), null);
  assert.equal(parseRule('REST:/'), null);
});

test('route table matches services, methods and REST paths', () => {
  const { table, warnings } = RouteTable.compile([
    'aiserver.v1.AuthService',
    'aiserver.v1.AiService/AvailableModels',
    'REST:/auth/poll',
    'REST:/dashboard/*',
  ]);
  assert.deepEqual(warnings, []);

  assert.equal(table.match('/aiserver.v1.AuthService/GetMe')?.kind, 'service');
  assert.equal(table.match('/aiserver.v1.AiService/AvailableModels')?.kind, 'method');
  assert.equal(table.match('/auth/poll')?.kind, 'rest');
  assert.equal(table.match('/dashboard/anything/deeper')?.kind, 'rest');

  // A sibling method of an unclaimed service must not match.
  assert.equal(table.match('/aiserver.v1.AiService/SomethingElse'), null);
  assert.equal(table.match('/auth/pollx'), null);
});

test('route table reports malformed rules without dropping the good ones', () => {
  const { table, warnings } = RouteTable.compile(['aiserver.v1.AuthService', 'nonsense', 42]);
  assert.equal(table.size, 1);
  assert.equal(warnings.length, 2);
});

test('longest REST prefix wins', () => {
  const { table } = RouteTable.compile(['REST:/a/*', 'REST:/a/b/*']);
  assert.equal(table.match('/a/b/c')?.value, '/a/b/');
  assert.equal(table.match('/a/z')?.value, '/a/');
});

test('normalisePath strips query and fragment', () => {
  assert.equal(normalisePath('/svc/Method?x=1#frag'), '/svc/Method');
  assert.equal(normalisePath('/svc/Method'), '/svc/Method');
});

test('splitRpcPath only accepts two-segment paths', () => {
  assert.deepEqual(splitRpcPath('/pkg.Svc/Method'), { service: 'pkg.Svc', method: 'Method' });
  assert.equal(splitRpcPath('/pkg.Svc'), null);
  assert.equal(splitRpcPath('/pkg.Svc/Method/extra'), null);
});

test('default host patterns cover the hosts Cursor actually uses', () => {
  const { matcher, warnings } = HostMatcher.compile(DEFAULT_HOST_PATTERNS);
  assert.deepEqual(warnings, []);

  for (const host of [
    'api2.cursor.sh',
    'api3.cursor.sh',
    'api4.cursor.sh',
    'gcpp.cursor.sh',
    'api.playground.cursor.sh',
    'API2.CURSOR.SH',
  ]) {
    assert.equal(matcher.matches(host), true, `${host} should be captured`);
  }

  for (const host of ['cursor.sh', 'example.com', 'api2.cursor.sh.evil.com', '', 'localhost']) {
    assert.equal(matcher.matches(host), false, `${host} should not be captured`);
  }
});

test('an invalid host pattern is skipped without disabling the rest', () => {
  const { matcher, warnings } = HostMatcher.compile(['^good$', '[unclosed']);
  assert.equal(matcher.matches('good'), true);
  assert.equal(warnings.length, 1);
});

test('router passes through when byok mode is off', () => {
  const { router } = RequestRouter.compile({
    byokMode: false,
    hostPatterns: ['^api2\\.cursor\\.sh$'],
    redirect: ['aiserver.v1.AuthService'],
  });
  const decision = router.resolve({ host: 'api2.cursor.sh', path: '/aiserver.v1.AuthService/GetMe' });
  assert.equal(decision.action, 'passthrough');
  assert.equal(decision.reason, 'byok-disabled');
});

test('router distinguishes capture from intercept by whether a path is known', () => {
  const { router } = RequestRouter.compile({
    byokMode: true,
    hostPatterns: ['^api2\\.cursor\\.sh$'],
    redirect: ['aiserver.v1.AuthService'],
  });

  // The socket layer has no path yet.
  assert.equal(router.resolve({ host: 'api2.cursor.sh' }).action, 'capture');
  // Path-aware layers get a definite verdict.
  assert.equal(
    router.resolve({ host: 'api2.cursor.sh', path: '/aiserver.v1.AuthService/GetMe' }).action,
    'intercept',
  );
  assert.equal(
    router.resolve({ host: 'api2.cursor.sh', path: '/aiserver.v1.Other/Method' }).action,
    'passthrough',
  );
  assert.equal(router.resolve({ host: 'example.com', path: '/x/y' }).action, 'passthrough');
});

test('the shipped default route table leaves feature gates on the official API', () => {
  const config = createDefaultConfig();
  const { router } = RequestRouter.compile({
    byokMode: true,
    hostPatterns: config.interception.hostPatterns,
    redirect: config.redirect,
  });

  // Claiming BootstrapStatsig would disable Cursor's feature gates, and with
  // them parts of its native tool surface.
  assert.equal(
    router.resolve({
      host: 'api2.cursor.sh',
      path: '/aiserver.v1.AnalyticsService/BootstrapStatsig',
    }).action,
    'passthrough',
  );
  // Marketplace discovery likewise stays native.
  assert.equal(
    router.resolve({
      host: 'api2.cursor.sh',
      path: '/aiserver.v1.DashboardService/ListMarketplacePlugins',
    }).action,
    'passthrough',
  );
  // The agent transport path is claimed, which is what replaces bundle surgery.
  assert.equal(
    router.resolve({ host: 'api2.cursor.sh', path: '/agent/v1/run' }).action,
    'intercept',
  );
});
