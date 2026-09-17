/**
 * Native agent chat: the end-to-end proof for Cursor's own conversation path.
 *
 * This is the capability that needed the schema most. Cursor's agent protocol
 * does not send a tool list — its tools are *protocol-level*, a closed oneof
 * of typed messages — so serving a turn means supplying the tool catalogue
 * from the schema and translating the model's reply back into the right typed
 * message. Both halves are checked here against the descriptors recovered
 * from the installed Cursor.
 *
 * The flow mirrors the real client exactly: `BidiAppend` parks a run request,
 * `RunSSE` opens a stream for the same request id, and the two meet at the
 * rendezvous. Only the model provider and the official API are mocked.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

await import('../harness/lib/dns-override.cjs');

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig } from '@mycursor/core/config';
import { extractDescriptors, locateInstalls } from '@mycursor/patcher';
import { decodeEnvelopes, parseContentType, unaryResponse } from '@mycursor/protocol/connect';
import { DescriptorRegistry, decodeMessage, encodeMessage } from '@mycursor/protocol/schema';
import { MyCursorServer, buildNativeTools } from '@mycursor/server';

import { startMockProvider } from '../harness/lib/mock-provider.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const workDir = join(repoRoot, '.verify-out', 'agent-turn');
const configHome = join(workDir, 'home');

const PLAIN_PORT = 39881;
const TLS_PORT = 39882;
const REQUEST_ID = 'req-verify-0001';
const BIDI_PATH = '/aiserver.v1.BidiService/BidiAppend';
const RUNSSE_PATH = '/agent.v1.AgentService/RunSSE';

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const model = (id, apiModel) => ({
  id,
  apiModel,
  displayName: id,
  enabled: true,
  capabilities: { agent: true, images: false, cmdK: true, fast: false, thinking: false, thinkingLevel: 'medium' },
  contextTokenLimit: 200000,
  maxOutputTokens: 64000,
  quickSwitch: { reasoningLevels: [], contextOptions: [], fastToggle: false },
});

/** A BYOK server on its own port and config home, so sections cannot collide. */
async function startByokServer({ name, port, providerBaseUrl, descriptorsPath }) {
  const home = join(workDir, name);
  mkdirSync(home, { recursive: true });

  const config = createDefaultConfig();
  config.server = { host: '127.0.0.1', port, tlsPort: port + 1 };
  config.uplink.mode = 'local';
  config.interception.hostPatterns = ['^api2\\.cursor\\.test$'];
  config.redirect = ['agent.v1.AgentService/RunSSE', 'aiserver.v1.BidiService/BidiAppend'];

  const configPath = join(home, 'config.json');
  const providersPath = join(home, 'providers.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    providersPath,
    `${JSON.stringify(
      {
        $schemaVersion: 2,
        providers: [
          {
            id: 'mock',
            name: 'Mock',
            type: 'openai-chat',
            baseUrl: providerBaseUrl,
            authValue: 'test-key',
            enabled: true,
            // Two models so a run that picks the wrong one is visible in the
            // API model the provider was called with.
            models: [model('my-agent-model', 'mock-model'), model('my-review-model', 'mock-review')],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const server = new MyCursorServer({
    configPath,
    providersPath,
    descriptorsPath,
    tlsDirectory: home,
    logLevel: 'warn',
  });
  const running = await server.listen();
  return { running, home, base: `http://127.0.0.1:${running.plainPort}` };
}

/** Drives one turn the way the real client does: park, then stream. */
async function runTurn(base, registry, requestId, runRequest) {
  const append = await fetch(`${base}${BIDI_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/proto', 'x-mycursor-upstream': 'api2.cursor.test' },
    body: encodeMessage(registry, 'aiserver.v1.BidiAppendRequest', {
      requestId: { requestId },
      appendSeqno: '1',
      dataBinary: encodeMessage(registry, 'agent.v1.AgentClientMessage', { runRequest }),
    }),
  });

  const response = await fetch(`${base}${RUNSSE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/connect+proto', 'x-mycursor-upstream': 'api2.cursor.test' },
    body: encodeMessage(registry, 'aiserver.v1.BidiRequestId', { requestId }),
  });

  const updates = decodeEnvelopes(new Uint8Array(await response.arrayBuffer()))
    .filter((frame) => (frame.flags & 0b10) === 0)
    .map((frame) => decodeMessage(registry, 'agent.v1.AgentServerMessage', frame.payload))
    .map((message) => message.interactionUpdate)
    .filter(Boolean);

  return { appendStatus: append.status, status: response.status, updates };
}

/**
 * MCP tools declared by the client must reach the model alongside the
 * protocol catalogue, and come back as `mcpToolCall` with their arguments
 * intact. Unlike protocol tools these arrive in the request, so they carry
 * the same "forward verbatim" guarantee as the OpenAI-compatible path.
 */
async function verifyMcpForwarding(registry, document, descriptorsPath, protocolToolCount) {
  console.log('\n── MCP tools declared by the client');

  const provider = await startMockProvider({
    toolCall: {
      name: 'search_issues',
      argumentsJson: '{"query":"open bugs","limit":5,"includeClosed":false,"labels":["p0","ui"]}',
    },
  });

  const home = join(workDir, 'mcp-home');
  mkdirSync(home, { recursive: true });
  const config = createDefaultConfig();
  config.server = { host: '127.0.0.1', port: PLAIN_PORT + 10, tlsPort: TLS_PORT + 10 };
  config.uplink.mode = 'local';
  config.interception.hostPatterns = ['^api2\\.cursor\\.test$'];
  config.redirect = ['agent.v1.AgentService/RunSSE', 'aiserver.v1.BidiService/BidiAppend'];
  const configPath = join(home, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(home, 'providers.json'),
    `${JSON.stringify(
      {
        $schemaVersion: 2,
        providers: [
          {
            id: 'mock',
            name: 'Mock',
            type: 'openai-chat',
            baseUrl: provider.baseUrl,
            authValue: 'k',
            enabled: true,
            models: [
              {
                id: 'my-agent-model',
                apiModel: 'mock-model',
                displayName: 'M',
                enabled: true,
                capabilities: { agent: true, images: false, cmdK: true, fast: false, thinking: false, thinkingLevel: 'medium' },
                contextTokenLimit: 200000,
                maxOutputTokens: 64000,
                quickSwitch: { reasoningLevels: [], contextOptions: [], fastToggle: false },
              },
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
    providersPath: join(home, 'providers.json'),
    descriptorsPath,
    tlsDirectory: home,
    logLevel: 'warn',
  });
  const running = await server.listen();
  const base = `http://127.0.0.1:${running.plainPort}`;
  const requestId = 'req-mcp-0001';

  try {
    const clientMessage = encodeMessage(registry, 'agent.v1.AgentClientMessage', {
      runRequest: {
        conversationId: 'conv-mcp',
        requestedModel: { modelId: 'my-agent-model' },
        mcpTools: {
          mcpTools: [
            {
              name: 'search_issues',
              description: 'Search the issue tracker',
              toolName: 'search',
              providerIdentifier: 'tracker-mcp',
              inputSchemaJson: JSON.stringify({
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  limit: { type: 'integer' },
                  includeClosed: { type: 'boolean' },
                  labels: { type: 'array', items: { type: 'string' } },
                },
                required: ['query'],
              }),
            },
          ],
        },
        action: {
          userMessageAction: { userMessage: { text: 'find open bugs' } },
        },
      },
    });

    await fetch(`${base}${BIDI_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/proto', 'x-mycursor-upstream': 'api2.cursor.test' },
      body: encodeMessage(registry, 'aiserver.v1.BidiAppendRequest', {
        requestId: { requestId },
        appendSeqno: '1',
        dataBinary: clientMessage,
      }),
    });

    const runResponse = await fetch(`${base}${RUNSSE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/connect+proto',
        'x-mycursor-upstream': 'api2.cursor.test',
      },
      body: encodeMessage(registry, 'aiserver.v1.BidiRequestId', { requestId }),
    });
    check('RunSSE served the MCP turn locally', runResponse.status === 200, String(runResponse.status));

    const frames = decodeEnvelopes(new Uint8Array(await runResponse.arrayBuffer()));
    const updates = frames
      .filter((frame) => (frame.flags & 0b10) === 0)
      .map((frame) => decodeMessage(registry, 'agent.v1.AgentServerMessage', frame.payload))
      .map((message) => message.interactionUpdate)
      .filter(Boolean);

    const seen = provider.requests.at(-1);
    const sentTools = (seen?.tools ?? []).map((tool) => tool.function?.name);
    check('the MCP tool was offered alongside the protocol catalogue',
      sentTools.includes('search_issues') && sentTools.length === protocolToolCount + 1,
      `${sentTools.length} tools = ${protocolToolCount} protocol + 1 MCP`);

    const mcpTool = seen?.tools?.find((tool) => tool.function?.name === 'search_issues');
    check('the client-declared description was forwarded verbatim',
      mcpTool?.function?.description === 'Search the issue tracker',
      JSON.stringify(mcpTool?.function?.description));
    check('the client-declared JSON Schema was forwarded verbatim',
      JSON.stringify(mcpTool?.function?.parameters?.required) === '["query"]' &&
        mcpTool.function.parameters.properties.labels.items.type === 'string',
      JSON.stringify(Object.keys(mcpTool?.function?.parameters?.properties ?? {})));

    const started = updates.find((update) => update.toolCallStarted);
    const toolCall = started?.toolCallStarted?.toolCall;
    check('the MCP call came back as mcpToolCall, not a protocol tool',
      Boolean(toolCall?.mcpToolCall),
      toolCall ? Object.keys(toolCall).filter((key) => key !== 'toolCallId').join(', ') : 'none');

    const args = toolCall?.mcpToolCall?.args;
    check('the MCP server identity was carried back',
      args?.name === 'search_issues' && args?.toolName === 'search' &&
        args?.providerIdentifier === 'tracker-mcp',
      JSON.stringify({ name: args?.name, toolName: args?.toolName, provider: args?.providerIdentifier }));

    // Arguments travel as map<string, google.protobuf.Value>, so every JSON
    // type has to survive the wrapping.
    check('string and number arguments survived the Value wrapping',
      args?.args?.query?.stringValue === 'open bugs' && args?.args?.limit?.numberValue === 5,
      JSON.stringify({ query: args?.args?.query, limit: args?.args?.limit }));
    check('boolean arguments survived',
      args?.args?.includeClosed?.boolValue === false,
      JSON.stringify(args?.args?.includeClosed));
    check('array arguments survived as a list value',
      args?.args?.labels?.listValue?.values?.map((value) => value.stringValue).join(',') === 'p0,ui',
      JSON.stringify(args?.args?.labels));
  } finally {
    await running.close();
    await provider.close();
  }
}

/**
 * The user's configuration has to survive the handover.
 *
 * Cursor attaches the user's rules, their installed skills and their custom
 * subagents to every run. A turn that drops them still answers, so nothing
 * looks broken — it just quietly ignores everything the user configured, and
 * a subagent given a cheap model silently runs on the expensive one.
 */
async function verifyTurnContext(registry, descriptorsPath) {
  const provider = await startMockProvider();
  const { running, base } = await startByokServer({
    name: 'context-home',
    port: PLAIN_PORT + 20,
    providerBaseUrl: provider.baseUrl,
    descriptorsPath,
  });

  /** The system message is where all of this is supposed to land. */
  const systemPrompt = () =>
    String(provider.requests.at(-1)?.messages?.find((message) => message.role === 'system')?.content ?? '');

  try {
    console.log('\n── User rules and skills reach the model');

    const contextTurn = await runTurn(base, registry, 'req-ctx-0001', {
      conversationId: 'conv-ctx',
      requestedModel: { modelId: 'my-agent-model' },
      // Clients put skill options either here or inside the request context.
      skillOptions: {
        skillDescriptors: [
          { name: 'top-level-skill', description: 'Declared on the run request', enabled: true },
        ],
      },
      action: {
        userMessageAction: {
          userMessage: { text: 'go' },
          requestContext: {
            rules: [
              { fullPath: '.cursor/rules/style.mdc', content: 'Always use tabs.', isRequired: true },
              { fullPath: '.cursor/rules/broken.mdc', content: 'junk', parseError: 'bad frontmatter' },
            ],
            nonFileRules: [{ fullPath: 'user-rules', content: 'Reply in Chinese.' }],
            skillOptions: {
              skillDescriptors: [
                { name: 'pdf-fill', description: 'Fill in PDF forms', folderPath: '/skills/pdf', enabled: true },
                { name: 'retired', description: 'Old skill', folderPath: '/skills/old', enabled: false },
              ],
            },
          },
        },
      },
    });
    check('the turn with context was served locally', contextTurn.status === 200, String(contextTurn.status));

    const prompt = systemPrompt();
    check('a file-scoped rule reached the system prompt',
      prompt.includes('Always use tabs.'), JSON.stringify(prompt.slice(0, 80)));
    check('a non-file user rule reached it too', prompt.includes('Reply in Chinese.'));
    check('the always-applies flag was carried across', prompt.includes('always applies'));
    check('a rule that failed to parse was left out', !prompt.includes('junk'));
    check('an enabled skill was listed with its description',
      prompt.includes('pdf-fill') && prompt.includes('Fill in PDF forms'));
    check('a disabled skill was left out', !prompt.includes('retired'));
    check('skills declared on the run request were read too',
      prompt.includes('top-level-skill'));

    console.log('\n── A subagent runs on the model the user chose for it');

    const reviewer = {
      name: 'reviewer',
      description: 'Reviews code',
      model: 'my-review-model',
      prompt: 'You only review code.',
      tools: ['read', 'grep'],
    };
    const subagentTurn = await runTurn(base, registry, 'req-ctx-0002', {
      conversationId: 'conv-ctx',
      requestedModel: { modelId: 'my-agent-model' },
      subagentTypeName: 'reviewer',
      action: {
        userMessageAction: {
          userMessage: { text: 'review this' },
          requestContext: { customSubagents: [reviewer] },
        },
      },
    });
    check('the subagent turn was served locally', subagentTurn.status === 200, String(subagentTurn.status));
    check('the subagent used its own model, not the conversation model',
      provider.requests.at(-1)?.model === 'mock-review', provider.requests.at(-1)?.model);
    check('the subagent brief reached the system prompt',
      systemPrompt().includes('You only review code.'));

    // A subagent limited to read-only tools must not be handed `shell`.
    const offered = (provider.requests.at(-1)?.tools ?? []).map((tool) => tool.function?.name);
    check('the subagent was restricted to the tools it declares',
      offered.length === 2 && offered.includes('read') && offered.includes('grep'),
      offered.join(', '));
    check('a restricted subagent was not offered shell', !offered.includes('shell'));

    console.log('\n── The fallbacks behave');

    await runTurn(base, registry, 'req-ctx-0003', {
      conversationId: 'conv-ctx',
      requestedModel: { modelId: 'my-agent-model' },
      subagentTypeName: 'reviewer',
      action: {
        userMessageAction: {
          userMessage: { text: 'review this' },
          requestContext: { customSubagents: [{ ...reviewer, forceDefaultModel: true }] },
        },
      },
    });
    check('forceDefaultModel pins the subagent to the conversation model',
      provider.requests.at(-1)?.model === 'mock-model', provider.requests.at(-1)?.model);

    // The override is keyed by subagent name, so it is the only source that
    // can be trusted when several subagents are configured at once.
    await runTurn(base, registry, 'req-ctx-0004', {
      conversationId: 'conv-ctx',
      requestedModel: { modelId: 'my-agent-model' },
      subagentTypeName: 'explore',
      subagentModelOverrides: [
        { subagentType: 'debug', model: { modelId: 'my-agent-model' } },
        { subagentType: 'explore', model: { modelId: 'my-review-model' } },
      ],
      action: { userMessageAction: { userMessage: { text: 'explore' } } },
    });
    check('a keyed override picks the model for this subagent, not another',
      provider.requests.at(-1)?.model === 'mock-review', provider.requests.at(-1)?.model);

    await runTurn(base, registry, 'req-ctx-0005', {
      conversationId: 'conv-ctx',
      requestedModel: { modelId: 'my-agent-model' },
      subagentTypeName: 'reviewer',
      subagentModelOverrides: [{ subagentType: 'reviewer', inherit: true }],
      action: {
        userMessageAction: {
          userMessage: { text: 'review' },
          requestContext: { customSubagents: [reviewer] },
        },
      },
    });
    check('an inherit override beats the model in the subagent definition',
      provider.requests.at(-1)?.model === 'mock-model', provider.requests.at(-1)?.model);

    await runTurn(base, registry, 'req-ctx-0006', {
      conversationId: 'conv-ctx',
      requestedModel: { modelId: 'my-agent-model' },
      subagentTypeName: 'explore',
      selectedSubagentModels: [{ modelId: 'my-review-model' }],
      action: { userMessageAction: { userMessage: { text: 'explore' } } },
    });
    check('a lone positional selection is still honoured',
      provider.requests.at(-1)?.model === 'mock-review', provider.requests.at(-1)?.model);

    // Several positional entries carry no hint of which subagent they belong
    // to, so guessing would silently bill the wrong model.
    await runTurn(base, registry, 'req-ctx-0007', {
      conversationId: 'conv-ctx',
      requestedModel: { modelId: 'my-agent-model' },
      subagentTypeName: 'explore',
      selectedSubagentModels: [{ modelId: 'my-review-model' }, { modelId: 'my-agent-model' }],
      action: { userMessageAction: { userMessage: { text: 'explore' } } },
    });
    check('an ambiguous positional list is ignored rather than guessed',
      provider.requests.at(-1)?.model === 'mock-model', provider.requests.at(-1)?.model);

    await runTurn(base, registry, 'req-ctx-0008', {
      conversationId: 'conv-ctx',
      requestedModel: { modelId: 'my-agent-model' },
      action: { userMessageAction: { userMessage: { text: 'plain turn' } } },
    });
    const plain = provider.requests.at(-1);
    check('a turn with no context still runs on the conversation model',
      plain?.model === 'mock-model', plain?.model);
    check('a turn with no context gets the full tool catalogue',
      (plain?.tools ?? []).length > 30, `${plain?.tools?.length} tools`);
    check('a turn with no rules or skills sends no system message',
      !plain?.messages?.some((message) => message.role === 'system'),
      (plain?.messages ?? []).map((message) => message.role).join(','));
  } finally {
    await running.close();
    await provider.close();
  }
}

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });
  console.log('mycursor native agent turn verification');

  // ---------------------------------------------- schema and tool catalogue --

  const env = { ...process.env };
  delete env.MYCURSOR_CURSOR_ROOT;
  const install = locateInstalls(env).installs.find((entry) => entry.kind === 'desktop');
  if (!install) {
    console.error('no desktop Cursor installation found; this verification reads its schema');
    process.exit(2);
  }
  const document = extractDescriptors(install).document;
  const registry = DescriptorRegistry.fromDocument(document);

  console.log('\n── Native tool catalogue derived from the schema');
  const tools = buildNativeTools(registry);
  const names = tools.map((tool) => tool.name);
  check('catalogue was derived from the installed Cursor', tools.length > 30,
    `${tools.length} tools from Cursor ${document.cursorVersion}`);
  for (const expected of ['read', 'edit', 'shell', 'grep', 'glob', 'ls', 'sem_search']) {
    check(`catalogue includes "${expected}"`, names.includes(expected));
  }
  const read = tools.find((tool) => tool.name === 'read');
  check('tool parameters came from the args message',
    read?.argsType === 'agent.v1.ReadToolArgs' &&
      Object.keys(read.parameters.properties ?? {}).join(',') === 'path,offset,limit,includeLineNumbers',
    Object.keys(read?.parameters?.properties ?? {}).join(', '));

  const descriptorsPath = join(configHome, 'cursor-descriptors.json');
  writeFileSync(descriptorsPath, JSON.stringify(document));

  // ------------------------------------------------------------- server ----

  const provider = await startMockProvider();
  const config = createDefaultConfig();
  config.server = { host: '127.0.0.1', port: PLAIN_PORT, tlsPort: TLS_PORT };
  config.uplink.mode = 'local';
  config.interception.hostPatterns = ['^api2\\.cursor\\.test$'];
  config.redirect = ['agent.v1.AgentService/RunSSE', 'aiserver.v1.BidiService/BidiAppend'];

  const configPath = join(configHome, 'config.json');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(
    join(configHome, 'providers.json'),
    `${JSON.stringify(
      {
        $schemaVersion: 2,
        providers: [
          {
            id: 'mock',
            name: 'Mock',
            type: 'openai-chat',
            baseUrl: provider.baseUrl,
            authValue: 'test-key',
            enabled: true,
            models: [
              {
                id: 'my-agent-model',
                apiModel: 'mock-model',
                displayName: 'My Agent Model',
                enabled: true,
                capabilities: { agent: true, images: false, cmdK: true, fast: false, thinking: false, thinkingLevel: 'medium' },
                contextTokenLimit: 200000,
                maxOutputTokens: 64000,
                quickSwitch: { reasoningLevels: [], contextOptions: [], fastToggle: false },
              },
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
  const base = `http://127.0.0.1:${running.plainPort}`;

  try {
    // ------------------------------------------------- build a run request --

    console.log('\n── The client half: BidiAppend parks a run request');
    const clientMessage = encodeMessage(registry, 'agent.v1.AgentClientMessage', {
      runRequest: {
        conversationId: 'conv-verify',
        requestedModel: { modelId: 'my-agent-model' },
        action: {
          userMessageAction: {
            userMessage: { text: 'Please read config.json and summarise it.' },
            conversationHistory: {
              messages: [
                { user: { content: [{ text: { text: 'hello there' } }] } },
                {
                  assistant: {
                    content: [
                      { text: { text: 'Hi! What would you like me to do?' } },
                      {
                        toolCall: {
                          toolCallId: 'earlier-call',
                          toolName: 'ls',
                          argsJson: '{"path":"."}',
                        },
                      },
                    ],
                  },
                },
                {
                  tool: {
                    toolCallId: 'earlier-call',
                    toolName: 'ls',
                    content: [{ text: { text: 'config.json\nREADME.md' } }],
                  },
                },
              ],
            },
          },
        },
      },
    });

    const appendBody = encodeMessage(registry, 'aiserver.v1.BidiAppendRequest', {
      requestId: { requestId: REQUEST_ID },
      appendSeqno: '1',
      dataBinary: clientMessage,
    });

    const appendResponse = await fetch(`${base}${BIDI_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/proto', 'x-mycursor-upstream': 'api2.cursor.test' },
      body: appendBody,
    });
    check('BidiAppend was accepted locally', appendResponse.status === 200, String(appendResponse.status));

    // --------------------------------------------------- open the stream ----

    console.log('\n── The server half: RunSSE streams the turn back');
    const runBody = encodeMessage(registry, 'aiserver.v1.BidiRequestId', { requestId: REQUEST_ID });
    const runResponse = await fetch(`${base}${RUNSSE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/connect+proto',
        'x-mycursor-upstream': 'api2.cursor.test',
      },
      body: runBody,
    });
    check('RunSSE answered locally', runResponse.status === 200, String(runResponse.status));

    const raw = new Uint8Array(await runResponse.arrayBuffer());
    const frames = decodeEnvelopes(raw);
    check('the stream is Connect-framed', frames.length > 0, `${frames.length} frames, ${raw.length} bytes`);

    // The last frame is the end-of-stream marker, not a message.
    const messages = frames
      .filter((frame) => (frame.flags & 0b10) === 0)
      .map((frame) => decodeMessage(registry, 'agent.v1.AgentServerMessage', frame.payload));

    const updates = messages
      .map((message) => message.interactionUpdate)
      .filter(Boolean);
    check('every frame is an interaction update', updates.length === messages.length,
      `${updates.length}/${messages.length}`);

    const text = updates
      .filter((update) => update.textDelta)
      .map((update) => update.textDelta.text)
      .join('');
    check('the provider text arrived as text deltas', text === 'hello from mock', JSON.stringify(text));

    const started = updates.find((update) => update.toolCallStarted);
    check('the tool call arrived as a started update', Boolean(started));
    check('the call id was preserved', started?.toolCallStarted?.callId === 'call_1',
      started?.toolCallStarted?.callId);

    // The decisive check. The mock model answers with `read_file`, the name a
    // model reaches for from training rather than the protocol's own `read`,
    // so this also exercises alias resolution.
    const toolCall = started?.toolCallStarted?.toolCall;
    check('the model tool call became a typed protocol message',
      Boolean(toolCall?.readToolCall),
      toolCall ? Object.keys(toolCall).filter((key) => key !== 'toolCallId').join(', ') : 'none');
    check('the arguments were coerced into the args message',
      toolCall?.readToolCall?.args?.path === 'a.txt',
      JSON.stringify(toolCall?.readToolCall?.args));

    const ended = updates.find((update) => update.turnEnded);
    check('the turn was closed with usage totals',
      Boolean(ended) && ended.turnEnded.inputTokens === '11' && ended.turnEnded.outputTokens === '7',
      JSON.stringify(ended?.turnEnded));

    // ------------------------------------------ what the provider received --

    console.log('\n── What the provider was actually sent');
    const seen = provider.requests.at(-1);
    check('the turn reached the provider', Boolean(seen), seen?.model);
    check('the request used the configured API model', seen?.model === 'mock-model', seen?.model);

    const sentTools = (seen?.tools ?? []).map((tool) => tool.function?.name);
    check('every native tool was offered to the model', sentTools.length === tools.length,
      `${sentTools.length} of ${tools.length}`);
    for (const expected of ['read', 'edit', 'shell', 'grep']) {
      check(`provider was told about "${expected}"`, sentTools.includes(expected));
    }
    const readTool = seen?.tools?.find((tool) => tool.function?.name === 'read');
    check('the tool schema reached the provider with its parameters',
      readTool?.function?.parameters?.properties?.path?.type === 'string' &&
        readTool.function.parameters.properties.limit.type === 'integer',
      JSON.stringify(Object.keys(readTool?.function?.parameters?.properties ?? {})));

    console.log('\n── Conversation history survived the translation');
    const roles = (seen?.messages ?? []).map((message) => message.role);
    check('history reached the provider in order',
      roles.join(',') === 'user,assistant,tool,user', roles.join(','));
    check('the earlier tool call was replayed',
      seen?.messages?.[1]?.tool_calls?.[0]?.function?.name === 'ls',
      JSON.stringify(seen?.messages?.[1]?.tool_calls?.[0]?.function));
    check('the tool result was replayed with its call id',
      seen?.messages?.[2]?.tool_call_id === 'earlier-call',
      seen?.messages?.[2]?.tool_call_id);
    check('the newest user message was appended last',
      String(seen?.messages?.at(-1)?.content ?? '').includes('summarise it'),
      String(seen?.messages?.at(-1)?.content ?? ''));

    console.log('\n── Degrading safely');
    const counters = running.status().counters;
    check('the server recorded the turn as locally served',
      (counters['rpc-local'] ?? 0) >= 2,
      Object.entries(counters).map(([key, value]) => `${key}=${value}`).join('  '));
  } finally {
    await running.close();
    await provider.close();
  }

  await verifyMcpForwarding(registry, document, descriptorsPath, tools.length);
  await verifyTurnContext(registry, descriptorsPath);

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed checks:');
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail ?? ''}`);
    process.exitCode = 1;
  }
}

await main();
