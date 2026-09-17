/**
 * Deriving Cursor's native tool catalogue from the schema.
 *
 * Cursor's agent protocol never sends a tool list — its tools are a closed
 * oneof of typed messages — so the server has to derive the catalogue and map
 * a model's reply back onto the right message. Both directions are pinned
 * here against a synthetic schema shaped like the real one, so the logic is
 * covered without needing a Cursor installation.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DescriptorRegistry, ScalarType, toJsonName } from '@mycursor/protocol/schema';
import { buildNativeTools, toToolCallMessage, toToolDescriptors } from '@mycursor/server';

function field(no, name, kind, extra = {}) {
  return { no, name, jsonName: toJsonName(name), kind, ...extra };
}

const registry = DescriptorRegistry.fromDocument({
  $schemaVersion: 1,
  cursorVersion: 'test',
  source: 'unit test',
  extractedAt: new Date(0).toISOString(),
  messages: {
    // Mirrors the real `agent.v1.ToolCall`: a oneof of typed tools plus
    // metadata fields that are not tools.
    'agent.v1.ToolCall': [
      field(1, 'read_tool_call', 'message', { typeName: 'agent.v1.ReadToolCall', oneof: 'tool' }),
      field(2, 'shell_tool_call', 'message', { typeName: 'agent.v1.ShellToolCall', oneof: 'tool' }),
      field(3, 'sem_search_tool_call', 'message', {
        typeName: 'agent.v1.SemSearchToolCall',
        oneof: 'tool',
      }),
      field(4, 'truncated_tool_call', 'message', {
        typeName: 'agent.v1.TruncatedToolCall',
        oneof: 'tool',
      }),
      field(57, 'tool_call_id', 'scalar', { scalar: ScalarType.STRING }),
      field(59, 'started_at_ms', 'scalar', { scalar: ScalarType.UINT64 }),
    ],
    'agent.v1.ReadToolCall': [
      field(1, 'args', 'message', { typeName: 'agent.v1.ReadToolArgs' }),
      field(2, 'result', 'message', { typeName: 'agent.v1.ReadToolResult' }),
    ],
    'agent.v1.ReadToolArgs': [
      field(1, 'path', 'scalar', { scalar: ScalarType.STRING }),
      field(2, 'offset', 'scalar', { scalar: ScalarType.INT32 }),
      field(5, 'include_line_numbers', 'scalar', { scalar: ScalarType.BOOL }),
    ],
    'agent.v1.ReadToolResult': [field(1, 'text', 'scalar', { scalar: ScalarType.STRING })],
    'agent.v1.ShellToolCall': [field(1, 'args', 'message', { typeName: 'agent.v1.ShellArgs' })],
    'agent.v1.ShellArgs': [
      field(1, 'command', 'scalar', { scalar: ScalarType.STRING }),
      field(5, 'simple_commands', 'scalar', { scalar: ScalarType.STRING, repeated: true }),
      field(9, 'requested_sandbox_policy', 'enum', { typeName: 'agent.v1.SandboxPolicy' }),
    ],
    'agent.v1.SemSearchToolCall': [
      field(1, 'args', 'message', { typeName: 'agent.v1.SemSearchArgs' }),
    ],
    'agent.v1.SemSearchArgs': [field(1, 'query', 'scalar', { scalar: ScalarType.STRING })],
    'agent.v1.TruncatedToolCall': [field(1, 'reason', 'scalar', { scalar: ScalarType.STRING })],
  },
  enums: {
    'agent.v1.SandboxPolicy': [
      { no: 0, name: 'SANDBOX_POLICY_UNSPECIFIED' },
      { no: 1, name: 'SANDBOX_POLICY_READ_ONLY' },
    ],
  },
  services: {},
});

const tools = buildNativeTools(registry);

test('every typed tool in the oneof becomes a catalogue entry', () => {
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes('read'));
  assert.ok(names.includes('shell'));
  assert.ok(names.includes('sem_search'), 'camelCase is converted to snake_case');
});

test('metadata fields of the oneof are not mistaken for tools', () => {
  const names = tools.map((tool) => tool.name);
  assert.ok(!names.includes('tool_call_id'));
  assert.ok(!names.includes('started_at_ms'));
});

test('tools driven by Cursor rather than the model are withheld', () => {
  // Offering `truncated` invites a call the client cannot answer.
  assert.equal(tools.some((tool) => tool.name === 'truncated'), false);
});

test('parameters come from the args message, not the result', () => {
  const read = tools.find((tool) => tool.name === 'read');
  assert.equal(read.argsType, 'agent.v1.ReadToolArgs');
  assert.deepEqual(Object.keys(read.parameters.properties), ['path', 'offset', 'includeLineNumbers']);
  assert.equal(read.parameters.properties.path.type, 'string');
  assert.equal(read.parameters.properties.offset.type, 'integer');
  assert.equal(read.parameters.properties.includeLineNumbers.type, 'boolean');
});

test('repeated fields become arrays and enums become named strings', () => {
  const shell = tools.find((tool) => tool.name === 'shell');
  assert.equal(shell.parameters.properties.simpleCommands.type, 'array');
  assert.equal(shell.parameters.properties.simpleCommands.items.type, 'string');
  assert.deepEqual(shell.parameters.properties.requestedSandboxPolicy.enum, [
    'SANDBOX_POLICY_UNSPECIFIED',
    'SANDBOX_POLICY_READ_ONLY',
  ]);
});

test('descriptors are marked native so the registry preserves them', () => {
  const descriptors = toToolDescriptors(tools);
  assert.ok(descriptors.every((descriptor) => descriptor.origin === 'native'));
  assert.equal(descriptors.find((descriptor) => descriptor.name === 'read').parameters.additionalProperties, false);
});

test('a tool call maps back into the right field of the oneof', () => {
  const message = toToolCallMessage(registry, tools, {
    id: 'call_1',
    name: 'read',
    argumentsJson: '{"path":"a.txt","offset":10}',
  });
  assert.equal(message.toolCallId, 'call_1');
  assert.deepEqual(message.readToolCall.args, { path: 'a.txt', offset: 10 });
  assert.equal(message.shellToolCall, undefined);
});

test('names a model reaches for from training are accepted', () => {
  // Cursor's public names differ from the protocol's; a hallucinated name
  // otherwise costs the user a whole turn.
  for (const [given, expected] of [
    ['read_file', 'readToolCall'],
    ['run_terminal_cmd', 'shellToolCall'],
    ['codebase_search', 'semSearchToolCall'],
    ['bash', 'shellToolCall'],
  ]) {
    const message = toToolCallMessage(registry, tools, { id: 'x', name: given, argumentsJson: '{}' });
    assert.ok(message?.[expected], `${given} should resolve to ${expected}`);
  }
});

test('near-miss names resolve through normalisation', () => {
  const message = toToolCallMessage(registry, tools, {
    id: 'x',
    name: 'Read-Tool',
    argumentsJson: '{"path":"a"}',
  });
  assert.ok(message?.readToolCall);
});

test('an unknown tool is refused rather than guessed at', () => {
  assert.equal(
    toToolCallMessage(registry, tools, { id: 'x', name: 'launch_missiles', argumentsJson: '{}' }),
    null,
  );
});

test('loosely typed arguments are coerced to the declared types', () => {
  const message = toToolCallMessage(registry, tools, {
    id: 'x',
    name: 'read',
    // A model returning numbers and booleans as strings is routine.
    argumentsJson: '{"path":"a.txt","offset":"25","includeLineNumbers":"true"}',
  });
  assert.deepEqual(message.readToolCall.args, {
    path: 'a.txt',
    offset: 25,
    includeLineNumbers: true,
  });
});

test('enum arguments given by name are converted to their number', () => {
  const message = toToolCallMessage(registry, tools, {
    id: 'x',
    name: 'shell',
    argumentsJson: '{"command":"ls","requestedSandboxPolicy":"SANDBOX_POLICY_READ_ONLY"}',
  });
  assert.equal(message.shellToolCall.args.requestedSandboxPolicy, 1);
});

test('arguments the tool does not declare are dropped', () => {
  const message = toToolCallMessage(registry, tools, {
    id: 'x',
    name: 'read',
    argumentsJson: '{"path":"a.txt","nonsense":true}',
  });
  assert.deepEqual(Object.keys(message.readToolCall.args), ['path']);
});

test('malformed argument JSON does not throw', () => {
  const message = toToolCallMessage(registry, tools, {
    id: 'x',
    name: 'read',
    argumentsJson: '{not json',
  });
  assert.deepEqual(message.readToolCall.args, {});
});

test('an empty registry yields no catalogue rather than an empty tool set', () => {
  // The caller must be able to tell "schema missing" from "no tools", because
  // a model told it has no tools answers with prose where an edit is wanted.
  assert.deepEqual(buildNativeTools(DescriptorRegistry.empty()), []);
});
