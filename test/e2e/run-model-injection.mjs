/**
 * Model injection: the end-to-end proof of the headline BYOK capability.
 *
 * This is the verification that could not exist before Cursor's schema was
 * recoverable. It establishes four things that together mean "a configured
 * model appears in Cursor's picker and Cursor's own models are still there":
 *
 *  1. the schema extracted from the installed Cursor round trips a real
 *     `AvailableModelsResponse` through encode and decode;
 *  2. the server answers `AvailableModels` itself rather than forwarding it;
 *  3. the local models appear in the response, with the fields the picker
 *     reads actually populated;
 *  4. the models the official API returned are **still present** — injection
 *     appends, so enabling BYOK does not take away what the user had.
 *
 * Everything runs against the real extractor, the real codec and the real
 * server. Only the official API and the model provider are mocked, and the
 * installed Cursor is read but never written.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

await import('../harness/lib/dns-override.cjs');

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig } from '@mycursor/core/config';
import { extractDescriptors, locateInstalls } from '@mycursor/patcher';
import { parseContentType, unaryResponse } from '@mycursor/protocol/connect';
import {
  DescriptorRegistry,
  decodeMessage,
  encodeMessage,
} from '@mycursor/protocol/schema';
import { AVAILABLE_MODELS_RESPONSE_TYPE, MyCursorServer } from '@mycursor/server';

import { startMockProvider } from '../harness/lib/mock-provider.mjs';
import { startMockUpstream } from '../harness/lib/mock-upstream.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const workDir = join(repoRoot, '.verify-out', 'model-injection');
const configHome = join(workDir, 'home');

const AVAILABLE_MODELS_PATH = '/aiserver.v1.AiService/AvailableModels';
const PLAIN_PORT = 39871;
const TLS_PORT = 39872;

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Models the official API is pretending to return for a signed-in user. */
const UPSTREAM_MODELS = [
  { name: 'claude-4.5-sonnet', clientDisplayName: 'Claude 4.5 Sonnet', defaultOn: true, supportsAgent: true },
  { name: 'gpt-5', clientDisplayName: 'GPT-5', supportsAgent: true, supportsImages: true },
];

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });
  console.log('mycursor model injection verification');

  // ------------------------------------------------ schema from the install --

  console.log('\n── Schema recovered from the installed Cursor');
  const env = { ...process.env };
  delete env.MYCURSOR_CURSOR_ROOT;
  const install = locateInstalls(env).installs.find((entry) => entry.kind === 'desktop');
  if (!install) {
    console.error('no desktop Cursor installation found; this verification needs one to read from');
    process.exit(2);
  }

  const started = Date.now();
  const report = extractDescriptors(install);
  const registry = DescriptorRegistry.fromDocument(report.document);
  const stats = registry.stats();
  check(
    'descriptors extracted from the installation',
    stats.messages > 1000 && stats.methods > 100,
    `Cursor ${report.document.cursorVersion}: ${stats.messages} messages, ${stats.services} services, ${stats.methods} methods in ${Date.now() - started} ms`,
  );

  const method = registry.method('aiserver.v1.AiService', 'AvailableModels');
  check(
    'AvailableModels signature recovered from Cursor\'s own service definition',
    method?.kind === 'unary' && method?.output === AVAILABLE_MODELS_RESPONSE_TYPE,
    `${method?.kind} ${method?.input} -> ${method?.output}`,
  );

  const descriptorsPath = join(configHome, 'cursor-descriptors.json');
  writeFileSync(descriptorsPath, JSON.stringify(report.document));

  // ------------------------------------------------------- codec round trip --

  console.log('\n── Codec round trip on a real message type');
  const upstreamBody = encodeMessage(registry, AVAILABLE_MODELS_RESPONSE_TYPE, {
    models: UPSTREAM_MODELS,
    modelNames: UPSTREAM_MODELS.map((model) => model.name),
    useModelParameters: true,
  });
  const roundTripped = decodeMessage(registry, AVAILABLE_MODELS_RESPONSE_TYPE, upstreamBody);
  check(
    'encode then decode preserves every field',
    roundTripped.models?.length === 2 &&
      roundTripped.models[0].name === 'claude-4.5-sonnet' &&
      roundTripped.models[0].defaultOn === true &&
      roundTripped.models[1].supportsImages === true &&
      roundTripped.useModelParameters === true,
    `${upstreamBody.length} bytes, ${roundTripped.models?.length} models`,
  );

  // ------------------------------------------------------------ real server --

  const upstream = await startMockUpstream({
    responses: new Map([
      [
        AVAILABLE_MODELS_PATH,
        { contentType: 'application/proto', body: unaryResponse(parseContentType('application/proto'), upstreamBody).body },
      ],
    ]),
  });
  const provider = await startMockProvider();

  const config = createDefaultConfig();
  config.server = { host: '127.0.0.1', port: PLAIN_PORT, tlsPort: TLS_PORT };
  config.uplink.mode = 'local';
  config.upstream.port = upstream.port;
  config.interception.hostPatterns = ['^api2\\.cursor\\.test$'];
  config.redirect = ['aiserver.v1.AiService/AvailableModels'];

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
            models: [
              {
                id: 'my-local-sonnet',
                upstreamId: 'mock-model',
                displayName: 'My Local Sonnet',
                contextWindow: 200_000,
                maxOutputTokens: 64_000,
                supportsTools: true,
                supportsImages: true,
                supportsReasoning: true,
              },
              { id: 'my-local-mini', displayName: 'My Local Mini', contextWindow: 128_000 },
            ],
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
    descriptorsPath,
    tlsDirectory: configHome,
    logLevel: 'warn',
  });
  const running = await server.listen();

  try {
    console.log('\n── Server reports the schema it loaded');
    const status = running.status();
    check(
      'status reports the loaded schema',
      status.schema.available && status.schema.methods > 100,
      `Cursor ${status.schema.cursorVersion}: ${status.schema.messages} messages, ${status.schema.methods} methods`,
    );

    console.log('\n── AvailableModels answered locally with injection');
    const response = await fetch(`http://127.0.0.1:${running.plainPort}${AVAILABLE_MODELS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/proto',
        // The interceptor sets this; supplying it directly keeps the check on
        // the server's behaviour rather than on the interception layers, which
        // the other suites already cover.
        'x-mycursor-upstream': 'api2.cursor.test',
      },
      body: encodeMessage(registry, 'aiserver.v1.AvailableModelsRequest', {
        includeLongContextModels: true,
        useModelParameters: true,
      }),
    });

    check('response status is 200', response.status === 200, String(response.status));
    const decoded = decodeMessage(
      registry,
      AVAILABLE_MODELS_RESPONSE_TYPE,
      new Uint8Array(await response.arrayBuffer()),
    );

    const names = (decoded.models ?? []).map((model) => model.name);
    check(
      'both local models were injected',
      names.includes('my-local-sonnet') && names.includes('my-local-mini'),
      names.join(', '),
    );
    check(
      "Cursor's own models are still present",
      names.includes('claude-4.5-sonnet') && names.includes('gpt-5'),
      `${names.length} models total`,
    );
    check(
      'modelNames list matches the model list',
      (decoded.modelNames ?? []).includes('my-local-sonnet') &&
        (decoded.modelNames ?? []).includes('claude-4.5-sonnet'),
      (decoded.modelNames ?? []).join(', '),
    );
    check(
      'upstream fields survived the decode/encode cycle',
      decoded.useModelParameters === true &&
        decoded.models.find((model) => model.name === 'claude-4.5-sonnet')?.defaultOn === true,
      `useModelParameters=${decoded.useModelParameters}`,
    );

    const injected = decoded.models.find((model) => model.name === 'my-local-sonnet');
    check(
      'injected model carries the fields the picker reads',
      injected?.clientDisplayName === 'My Local Sonnet' &&
        injected?.supportsAgent === true &&
        injected?.supportsImages === true &&
        injected?.supportsThinking === true &&
        injected?.contextTokenLimit === 200_000 &&
        injected?.serverModelName === 'mock-model' &&
        injected?.isUserAdded === true,
      JSON.stringify({
        display: injected?.clientDisplayName,
        agent: injected?.supportsAgent,
        images: injected?.supportsImages,
        thinking: injected?.supportsThinking,
        context: injected?.contextTokenLimit,
        server: injected?.serverModelName,
        userAdded: injected?.isUserAdded,
      }),
    );
    check(
      'injected model tooltip names the provider',
      injected?.tooltipData?.primaryText === 'My Local Sonnet' &&
        String(injected?.tooltipData?.secondaryText ?? '').includes('mock'),
      JSON.stringify(injected?.tooltipData),
    );

    console.log('\n── Behaviour without a schema');
    // With no descriptors the server must serve the official list unchanged
    // rather than answer with a guessed encoding.
    const bareConfig = { ...config, server: { host: '127.0.0.1', port: 39873, tlsPort: 39874 } };
    const bareConfigPath = join(configHome, 'config-no-schema.json');
    writeFileSync(bareConfigPath, `${JSON.stringify(bareConfig, null, 2)}\n`);

    const bareServer = new MyCursorServer({
      configPath: bareConfigPath,
      providersPath: join(configHome, 'providers.json'),
      descriptorsPath: join(configHome, 'does-not-exist.json'),
      tlsDirectory: configHome,
      logLevel: 'error',
    });
    const bare = await bareServer.listen();
    try {
      const bareResponse = await fetch(`http://127.0.0.1:${bare.plainPort}${AVAILABLE_MODELS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/proto', 'x-mycursor-upstream': 'api2.cursor.test' },
        body: new Uint8Array(),
      });
      const bareDecoded = decodeMessage(
        registry,
        AVAILABLE_MODELS_RESPONSE_TYPE,
        new Uint8Array(await bareResponse.arrayBuffer()),
      );
      const bareNames = (bareDecoded.models ?? []).map((model) => model.name);
      check(
        'without descriptors the official list is served unchanged',
        !bareNames.includes('my-local-sonnet') && bareNames.includes('claude-4.5-sonnet'),
        bareNames.join(', '),
      );
      check(
        'status reports the schema as unavailable',
        bare.status().schema.available === false,
        `available=${bare.status().schema.available}`,
      );
    } finally {
      await bare.close();
    }
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

await main();
