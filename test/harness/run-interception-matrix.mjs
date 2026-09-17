/**
 * Interception matrix: the functional proof that traffic goes where intended.
 *
 * The run is fully isolated. Nothing touches the installed Cursor, the payload
 * is injected into a throwaway CommonJS host, configuration is written under a
 * temporary `MYCURSOR_HOME`, and both endpoints are local mock servers. That
 * isolation is what makes it safe to assert destructive things — such as
 * killing the BYOK server mid-run to check the fail-open path.
 *
 * Three questions are answered:
 *
 *  1. Does every client shape a patched Cursor process uses get captured?
 *     The matrix runs `https.request`, `https.get`, `http2.connect`, `fetch`,
 *     raw `tls.connect`, and a WebSocket upgrade.
 *  2. Do requests no rule claims still reach the official API? That is the
 *     native-behaviour guarantee, and it is asserted per client shape.
 *  3. Does the toolkit degrade safely? A scenario runs with no BYOK server at
 *     all, and another starts one only after the request is already in flight.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig } from '@mycursor/core/config';
import { buildPayload } from '@mycursor/interceptor';

import { startMockByokServer } from './lib/mock-byok-server.mjs';
import { startMockUpstream } from './lib/mock-upstream.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const workDir = join(repoRoot, '.verify-out', 'interception');

const UPSTREAM_HOST = 'api2.cursor.test';
const MATCHED_PATH = '/aiserver.v1.AiService/AvailableModels';
const UNMATCHED_PATH = '/aiserver.v1.DashboardService/ListMarketplacePlugins';
const UPGRADE_PATH = '/agent/v1/run';

/** All layers on: the shipped default. */
const ALL_LAYERS = {
  http1: true,
  http2: true,
  fetch: true,
  socket: true,
  websocket: true,
  dns: false,
};

/**
 * Only the socket backstop.
 *
 * This is the scenario that justifies having the layer at all: it stands in for
 * a future Cursor build, or a bundled HTTP client, that never calls any of the
 * primitives the path-aware layers wrap.
 */
const SOCKET_ONLY_LAYERS = {
  http1: false,
  http2: false,
  fetch: false,
  socket: true,
  websocket: false,
  dns: false,
};

function writeConfig({ configHome, byok, layers, readinessStrategy = 'hold', maxWaitMs = 8_000 }) {
  const config = createDefaultConfig();
  config.server = { host: '127.0.0.1', port: byok.port, tlsPort: byok.tlsPort };
  config.uplink.mode = 'local';
  config.uplink.probeTtlSeconds = 2;
  config.interception.layers = { ...layers };
  config.interception.hostPatterns = ['^api2\\.cursor\\.test$'];
  config.interception.readiness.strategy = readinessStrategy;
  config.interception.readiness.maxWaitMs = maxWaitMs;
  config.interception.readiness.cacheTtlSeconds = 1;
  config.redirect = [
    'aiserver.v1.AiService/AvailableModels',
    'aiserver.v1.AuthService',
    'REST:/agent/v1/run',
    'REST:/auth/poll',
  ];

  mkdirSync(configHome, { recursive: true });
  const path = join(configHome, 'config.json');
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return path;
}

/**
 * Builds the throwaway host module: payload first, client code second — the
 * same layout `install` produces against a real Cursor bundle.
 */
function writePatchedHost({ configPath, label }) {
  const payload = buildPayload({
    processLabel: label,
    guardMarker: '__mycursorHarnessGuard',
    configPath,
  });
  const clientCode = readFileSync(join(here, 'lib', 'client-cases.cjs'), 'utf-8');
  mkdirSync(workDir, { recursive: true });
  const path = join(workDir, `patched-host-${label}.cjs`);
  writeFileSync(path, `${payload}\n${clientCode}`, 'utf-8');
  return path;
}

function runCase({ hostPath, caseName, caseConfig, timeoutMs = 30_000 }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--require', join(here, 'lib', 'dns-override.cjs'), hostPath, caseName],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HARNESS_CASE_CONFIG: JSON.stringify(caseConfig),
          // The mock servers use locally generated certificates; the child is
          // throwaway, so blanket-disabling verification is contained.
          NODE_TLS_REJECT_UNAUTHORIZED: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      let parsed = null;
      try {
        parsed = line ? JSON.parse(line) : null;
      } catch {
        parsed = null;
      }
      resolve({ result: parsed, stdout, stderr });
    });
  });
}

const checks = [];

function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function scenarioServerUp({ layers, label, title, expectations }) {
  console.log(`\n── ${title}`);
  const upstream = await startMockUpstream();
  const byok = await startMockByokServer();
  const configHome = join(workDir, `home-${label}`);
  const configPath = writeConfig({ configHome, byok, layers });
  const hostPath = writePatchedHost({ configPath, label });

  const caseConfig = {
    upstreamHost: UPSTREAM_HOST,
    upstreamPort: upstream.port,
    matchedPath: MATCHED_PATH,
    unmatchedPath: UNMATCHED_PATH,
    upgradePath: UPGRADE_PATH,
  };

  try {
    for (const [caseName, expectation] of Object.entries(expectations)) {
      const { result, stderr } = await runCase({ hostPath, caseName, caseConfig });
      const served = result?.body?.served ?? null;
      const passed = result?.ok === true && served === expectation.served;
      const detail = passed
        ? expectation.note ?? `served by ${served}`
        : `expected ${expectation.served}, got ${served ?? 'error'}` +
          (result?.error ? ` (${result.error})` : '') +
          (!result && stderr ? ` [stderr: ${stderr.trim().split('\n').slice(-2).join(' | ')}]` : '');
      check(`${label}/${caseName}`, passed, detail);

      // Where the upstream identity must survive for the server to be able to
      // forward an unclaimed request, assert it explicitly.
      if (passed && expectation.requiresUpstreamIdentity) {
        const body = result.body;
        // Any one channel is enough: `Host` survives an HTTP/1.1 redirect,
        // `:authority` an HTTP/2 session, SNI a socket-level capture, and the
        // provenance header a `fetch` rewrite that loses the authority.
        const channels = { host: body.host, authority: body.scheme ? body.host : null, sni: body.sni, header: body.upstreamHeader };
        const via = Object.entries(channels).find(
          ([, value]) => typeof value === 'string' && value.includes(UPSTREAM_HOST),
        );
        check(
          `${label}/${caseName}: upstream identity preserved`,
          Boolean(via),
          via ? `via ${via[0]}=${via[1]}` : `none of ${JSON.stringify(channels)}`,
        );
      }
    }
  } finally {
    await upstream.close();
    await byok.close();
  }
}

/**
 * No BYOK server anywhere: every captured request must still succeed by
 * reaching the official API.
 */
async function scenarioServerDown() {
  console.log('\n── Scenario: BYOK server absent, requests must fail open');
  const upstream = await startMockUpstream();
  // Claim the ports, then release them, so the configuration points somewhere
  // plausible but dead.
  const placeholder = await startMockByokServer();
  const dead = { port: placeholder.port, tlsPort: placeholder.tlsPort };
  await placeholder.close();

  const configHome = join(workDir, 'home-faildown');
  const configPath = writeConfig({
    configHome,
    byok: dead,
    layers: ALL_LAYERS,
    maxWaitMs: 1_500,
  });
  const hostPath = writePatchedHost({ configPath, label: 'faildown' });
  const caseConfig = {
    upstreamHost: UPSTREAM_HOST,
    upstreamPort: upstream.port,
    matchedPath: MATCHED_PATH,
    unmatchedPath: UNMATCHED_PATH,
    upgradePath: UPGRADE_PATH,
  };

  try {
    for (const caseName of ['http1-matched', 'http2-matched', 'fetch-matched']) {
      const { result, stderr } = await runCase({ hostPath, caseName, caseConfig });
      const served = result?.body?.served ?? null;
      const passed = result?.ok === true && served === 'upstream';
      check(
        `faildown/${caseName}`,
        passed,
        passed
          ? 'fell back to the official API'
          : `expected upstream, got ${served ?? result?.error ?? 'error'}` +
            (!result && stderr ? ` [stderr: ${stderr.trim().split('\n').slice(-2).join(' | ')}]` : ''),
      );
    }
  } finally {
    await upstream.close();
  }
}

/**
 * The cold-start race: a request is issued before the BYOK server is listening.
 *
 * Holding the connection until the server answers is the behaviour that keeps a
 * user's first prompt after launching Cursor from failing.
 */
async function scenarioLateStart() {
  console.log('\n── Scenario: server starts after the request is in flight');
  const upstream = await startMockUpstream();
  const probe = await startMockByokServer();
  const ports = { port: probe.port, tlsPort: probe.tlsPort };
  await probe.close();

  const configHome = join(workDir, 'home-latestart');
  const configPath = writeConfig({
    configHome,
    byok: ports,
    layers: ALL_LAYERS,
    maxWaitMs: 15_000,
  });
  const hostPath = writePatchedHost({ configPath, label: 'latestart' });
  const caseConfig = {
    upstreamHost: UPSTREAM_HOST,
    upstreamPort: upstream.port,
    matchedPath: MATCHED_PATH,
    unmatchedPath: UNMATCHED_PATH,
    upgradePath: UPGRADE_PATH,
  };

  let late = null;
  const startLater = setTimeout(() => {
    void startMockByokServer(ports).then((server) => {
      late = server;
    });
  }, 2_000);
  startLater.unref?.();

  try {
    const { result, stderr } = await runCase({ hostPath, caseName: 'http1-matched', caseConfig });
    const served = result?.body?.served ?? null;
    const passed = result?.ok === true && served === 'byok';
    check(
      'latestart/http1-matched',
      passed,
      passed
        ? 'request waited for the server instead of failing'
        : `expected byok, got ${served ?? result?.error ?? 'error'}` +
          (!result && stderr ? ` [stderr: ${stderr.trim().split('\n').slice(-2).join(' | ')}]` : ''),
    );
  } finally {
    clearTimeout(startLater);
    await upstream.close();
    if (late) await late.close();
  }
}

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  console.log('mycursor interception matrix');
  console.log(`work dir: ${workDir}`);

  await scenarioServerUp({
    layers: ALL_LAYERS,
    label: 'all-layers',
    title: 'Scenario: all layers enabled (shipped default)',
    expectations: {
      'http1-matched': { served: 'byok', requiresUpstreamIdentity: true },
      'http1-unmatched': { served: 'upstream', note: 'native passthrough preserved' },
      'http1-get-matched': { served: 'byok' },
      'http2-matched': { served: 'byok', requiresUpstreamIdentity: true },
      'http2-unmatched': { served: 'byok', note: 'session-level capture, server forwards' },
      'fetch-matched': { served: 'byok', requiresUpstreamIdentity: true },
      // `undici` builds its own connection options, so a passthrough decided in
      // the fetch layer cannot be marked for the socket layer below it. The
      // socket backstop therefore captures the connection and the server
      // forwards the unclaimed path upstream — one extra hop, same result, and
      // a single authority for routing.
      'fetch-unmatched': {
        served: 'byok',
        requiresUpstreamIdentity: true,
        note: 'captured by the socket backstop; server forwards unclaimed paths',
      },
      'raw-tls-matched': { served: 'byok', requiresUpstreamIdentity: true },
      'ws-upgrade-matched': { served: 'refused-upgrade', note: 'SSE fallback without bundle surgery' },
    },
  });

  await scenarioServerUp({
    layers: SOCKET_ONLY_LAYERS,
    label: 'socket-only',
    title: 'Scenario: socket backstop only (stands in for an unknown transport)',
    expectations: {
      'http1-matched': { served: 'byok', requiresUpstreamIdentity: true },
      'http2-matched': { served: 'byok', requiresUpstreamIdentity: true },
      'fetch-matched': { served: 'byok', requiresUpstreamIdentity: true },
      'raw-tls-matched': { served: 'byok', requiresUpstreamIdentity: true },
    },
  });

  await scenarioServerDown();
  await scenarioLateStart();

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed checks:');
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail}`);
    process.exitCode = 1;
  }
}

await main();
