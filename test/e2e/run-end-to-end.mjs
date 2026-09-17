/**
 * End-to-end: the real payload, the real server, nothing mocked in between.
 *
 * The other two verifications each isolate one half. The interception matrix
 * uses a mock server so an interceptor bug cannot hide behind a server bug;
 * the sandbox install never runs any traffic. This one joins them: a Cursor-like
 * process carrying the real injected payload talks to the real BYOK server,
 * which talks to a mock official API and a mock provider.
 *
 * Three claims are settled here that neither half can settle alone:
 *
 *  1. a route rule reaches a real handler, not just "some local listener";
 *  2. a path no rule claims is *forwarded to the official API by the server* —
 *     the mechanism behind the promise that Cursor's native features survive,
 *     and the thing host-level capture would otherwise break;
 *  3. Cursor's own tool definitions arrive at the provider unchanged, verified
 *     by inspecting the request the provider received rather than by trusting
 *     the code that built it.
 *
 * Certificate verification is disabled for this process only: both mocks
 * present locally generated certificates and the process is throwaway.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// The server runs in this process and forwards to the mock official API by
// hostname, so the test domain has to resolve here too — not only in the child
// that carries the payload.
await import('../harness/lib/dns-override.cjs');

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig } from '@mycursor/core/config';
import { buildPayload } from '@mycursor/interceptor';
import { MyCursorServer } from '@mycursor/server';

import { startMockProvider } from '../harness/lib/mock-provider.mjs';
import { startMockUpstream } from '../harness/lib/mock-upstream.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const workDir = join(repoRoot, '.verify-out', 'e2e');
const configHome = join(workDir, 'home');

const UPSTREAM_HOST = 'api2.cursor.test';
const PLAIN_PORT = 39861;
const TLS_PORT = 39862;

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Cursor's own tools, as the client would declare them. */
const NATIVE_TOOLS = [
  {
    name: 'read_file',
    description: 'Read a file from the workspace',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_terminal_cmd',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  },
  {
    name: 'codebase_search',
    description: 'Semantic search across the codebase',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });
  console.log('mycursor end-to-end verification');

  const upstream = await startMockUpstream();
  const provider = await startMockProvider();
  console.log(`mock official API: 127.0.0.1:${upstream.port}`);
  console.log(`mock provider:     ${provider.baseUrl}`);

  const config = createDefaultConfig();
  config.server = { host: '127.0.0.1', port: PLAIN_PORT, tlsPort: TLS_PORT };
  config.uplink.mode = 'local';
  config.uplink.probeTtlSeconds = 2;
  config.interception.hostPatterns = ['^api2\\.cursor\\.test$'];
  config.interception.readiness.cacheTtlSeconds = 1;
  // The mock official API is on an unprivileged port.
  config.upstream.port = upstream.port;
  config.redirect = [
    // Claimed and answered with an empty protobuf message.
    'aiserver.v1.AuthService',
    'aiserver.v1.DashboardService/GetTeams',
    // Claimed REST stub.
    'REST:/auth/poll',
    // The agent WebSocket path, handled by policy.
    'REST:/agent/v1/run',
  ];

  const configPath = join(configHome, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(configHome, 'providers.json'),
    `${JSON.stringify(
      {
        $schemaVersion: 1,
        providers: [
          {
            id: 'mock',
            kind: 'openai',
            baseUrl: provider.baseUrl,
            apiKey: 'test-key',
            enabled: true,
            models: [{ id: 'mock-model', displayName: 'Mock Model', supportsTools: true }],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const server = new MyCursorServer({
    configPath,
    providersPath: join(configHome, 'providers.json'),
    tlsDirectory: configHome,
    logLevel: 'warn',
  });
  const running = await server.listen();
  console.log(`real BYOK server:  127.0.0.1:${running.plainPort} (tls ${running.tlsPort})\n`);

  const base = `http://127.0.0.1:${running.plainPort}`;

  try {
    console.log('── Control surface');
    const health = await fetch(`${base}/__mycursor/health`).then((r) => r.json());
    check(
      'health endpoint identifies the service',
      health.ok === true && health.service === 'mycursor',
      JSON.stringify(health),
    );

    const statusReport = await fetch(`${base}/__mycursor/status`).then((r) => r.json());
    check(
      'status reports the configured provider and model',
      statusReport.models === 1 && statusReport.providers[0]?.id === 'mock',
      `${statusReport.models} model(s) from ${statusReport.providers.length} provider(s)`,
    );

    console.log('\n── OpenAI-compatible façade preserves native tools');
    const completion = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
        tools: NATIVE_TOOLS.map((tool) => ({ type: 'function', function: tool })),
      }),
    }).then((r) => r.json());

    check(
      'completion returns the provider text',
      completion.choices?.[0]?.message?.content === 'hello from mock',
      JSON.stringify(completion.choices?.[0]?.message?.content),
    );
    check(
      'completion returns the provider tool call',
      completion.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'read_file' &&
        completion.choices[0].message.tool_calls[0].function.arguments === '{"path":"a.txt"}',
      JSON.stringify(completion.choices?.[0]?.message?.tool_calls?.[0]?.function),
    );

    const seen = provider.requests.at(-1);
    const seenNames = (seen?.tools ?? []).map((tool) => tool.function?.name);
    check(
      'every native tool reached the provider, in declaration order',
      seenNames.join(',') === NATIVE_TOOLS.map((tool) => tool.name).join(','),
      seenNames.join(', '),
    );

    const readFileTool = seen?.tools?.find((tool) => tool.function?.name === 'read_file');
    check(
      'native tool description survived unchanged',
      readFileTool?.function?.description === NATIVE_TOOLS[0].description,
      JSON.stringify(readFileTool?.function?.description),
    );
    check(
      'native tool JSON Schema survived unchanged',
      JSON.stringify(readFileTool?.function?.parameters) === JSON.stringify(NATIVE_TOOLS[0].parameters),
      JSON.stringify(readFileTool?.function?.parameters),
    );

    console.log('\n── Patched process talking to the real server');
    const payload = buildPayload({
      processLabel: 'e2e',
      guardMarker: '__mycursorE2eGuard',
      configPath,
    });
    const hostPath = join(workDir, 'patched-host.cjs');
    writeFileSync(
      hostPath,
      `${payload}\n${readFileSync(join(here, '..', 'harness', 'lib', 'client-cases.cjs'), 'utf-8')}`,
    );

    const caseConfig = {
      upstreamHost: UPSTREAM_HOST,
      upstreamPort: upstream.port,
      // Claimed by a route rule, answered with an empty protobuf message.
      matchedPath: '/aiserver.v1.DashboardService/GetTeams',
      // Claimed by no rule: the server must forward it to the official API.
      unmatchedPath: '/aiserver.v1.DashboardService/ListMarketplacePlugins',
      upgradePath: '/agent/v1/run',
    };

    const runCase = (caseName) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          ['--require', join(here, '..', 'harness', 'lib', 'dns-override.cjs'), hostPath, caseName],
          {
            cwd: repoRoot,
            env: {
              ...process.env,
              HARNESS_CASE_CONFIG: JSON.stringify(caseConfig),
              NODE_TLS_REJECT_UNAUTHORIZED: '0',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
        child.on('close', () => {
          clearTimeout(timer);
          const line = stdout.trim().split('\n').filter(Boolean).pop();
          resolve({ raw: stdout, stderr, parsed: safeJson(line) });
        });
      });

    // A claimed RPC path is answered by the server with an empty protobuf
    // message, so the client sees a 200 with a zero-length body — which the
    // harness client reports as a JSON parse failure rather than a marker.
    const matched = await runCase('http1-matched');
    check(
      'claimed RPC path was answered locally, not by the official API',
      matched.parsed?.body?.served === undefined,
      matched.parsed?.body?.served
        ? `reached ${matched.parsed.body.served}`
        : 'server answered with an empty protobuf message',
    );
    check(
      'the official API never saw the claimed path',
      !upstream.requests.some((entry) => entry.path === caseConfig.matchedPath),
      `official API saw: ${upstream.requests.map((entry) => entry.path).join(', ') || '(nothing)'}`,
    );

    // The decisive check for native behaviour: captured, then forwarded.
    const unmatchedBefore = upstream.requests.length;
    const unmatched = await runCase('http2-unmatched');
    check(
      'unclaimed path was forwarded to the official API by the server',
      unmatched.parsed?.body?.served === 'upstream',
      unmatched.parsed?.body?.served ?? unmatched.parsed?.error ?? 'no response',
    );
    check(
      'the forwarded request arrived upstream with its original path and host',
      upstream.requests
        .slice(unmatchedBefore)
        .some((entry) => entry.path === caseConfig.unmatchedPath && entry.host?.startsWith(UPSTREAM_HOST)),
      JSON.stringify(upstream.requests.slice(unmatchedBefore)),
    );

    const upgrade = await runCase('ws-upgrade-matched');
    check(
      'agent WebSocket upgrade was refused so the client falls back to SSE',
      upgrade.parsed?.body?.served === 'refused-upgrade' || upgrade.parsed?.body?.status === 426,
      JSON.stringify(upgrade.parsed?.body),
    );

    console.log('\n── Dispatch accounting');
    const finalStatus = running.status();
    check(
      'server recorded both a local answer and an upstream forward',
      (finalStatus.counters['rpc-empty'] ?? 0) > 0 && (finalStatus.counters['upstream'] ?? 0) > 0,
      Object.entries(finalStatus.counters)
        .map(([key, value]) => `${key}=${value}`)
        .join('  '),
    );
  } finally {
    await running.close();
    await upstream.close();
    await provider.close();
  }

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed checks:');
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail ?? ''}`);
    process.exitCode = 1;
  }
}

function safeJson(line) {
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

await main();
