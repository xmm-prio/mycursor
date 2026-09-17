/**
 * MCP tool forwarding and `google.protobuf.Value` conversion.
 *
 * MCP tools are the one part of an agent turn that *is* client-declared, so
 * they carry the same forward-verbatim guarantee as the OpenAI-compatible
 * path. Their arguments travel as `map<string, google.protobuf.Value>` rather
 * than a JSON string, and getting that wrapping wrong produces a tool call
 * that arrives with no arguments — which looks like the tool misbehaving
 * rather than like a translation bug.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Logger } from '@mycursor/core/logging';
import {
  DescriptorRegistry,
  ScalarType,
  fromProtoValue,
  hasStructTypes,
  toJsonName,
  toProtoValue,
  toValueMap,
} from '@mycursor/protocol/schema';
import { readMcpTools, toMcpDescriptors, toMcpToolCallMessage } from '@mycursor/server';

const silent = new Logger({ scope: 'test', level: 'error' });

function field(no, name, kind, extra = {}) {
  return { no, name, jsonName: toJsonName(name), kind, ...extra };
}

/** The well-known types, as the extractor recovers them from the bundle. */
const wellKnown = {
  'google.protobuf.Value': [
    field(1, 'null_value', 'enum', { typeName: 'google.protobuf.NullValue', oneof: 'kind' }),
    field(2, 'number_value', 'scalar', { scalar: ScalarType.DOUBLE, oneof: 'kind' }),
    field(3, 'string_value', 'scalar', { scalar: ScalarType.STRING, oneof: 'kind' }),
    field(4, 'bool_value', 'scalar', { scalar: ScalarType.BOOL, oneof: 'kind' }),
    field(5, 'struct_value', 'message', { typeName: 'google.protobuf.Struct', oneof: 'kind' }),
    field(6, 'list_value', 'message', { typeName: 'google.protobuf.ListValue', oneof: 'kind' }),
  ],
  'google.protobuf.Struct': [
    field(1, 'fields', 'map', {
      map: { key: ScalarType.STRING, value: { kind: 'message', typeName: 'google.protobuf.Value' } },
    }),
  ],
  'google.protobuf.ListValue': [
    field(1, 'values', 'message', { typeName: 'google.protobuf.Value', repeated: true }),
  ],
};

const registry = DescriptorRegistry.fromDocument({
  $schemaVersion: 1,
  cursorVersion: 'test',
  source: 'unit test',
  extractedAt: new Date(0).toISOString(),
  messages: { ...wellKnown },
  enums: {},
  services: {},
});

const bare = DescriptorRegistry.empty();

test('the registry reports whether the struct types are available', () => {
  assert.equal(hasStructTypes(registry), true);
  assert.equal(hasStructTypes(bare), false);
});

test('every JSON type round trips through Value', () => {
  for (const value of [
    'text',
    42,
    -1.5,
    true,
    false,
    null,
    ['a', 1, false],
    { nested: { deep: [1, 'two'] } },
  ]) {
    assert.deepEqual(fromProtoValue(toProtoValue(value)), value, `round trip of ${JSON.stringify(value)}`);
  }
});

test('Value sets exactly one field of the oneof', () => {
  assert.deepEqual(toProtoValue('x'), { stringValue: 'x' });
  assert.deepEqual(toProtoValue(3), { numberValue: 3 });
  assert.deepEqual(toProtoValue(false), { boolValue: false });
  assert.deepEqual(toProtoValue(null), { nullValue: 0 });
  assert.deepEqual(toProtoValue([1]), { listValue: { values: [{ numberValue: 1 }] } });
  assert.deepEqual(toProtoValue({ a: 1 }), { structValue: { fields: { a: { numberValue: 1 } } } });
});

test('a non-finite number becomes zero rather than a broken encoding', () => {
  // `NaN` and `Infinity` have no JSON representation; emitting them would
  // produce a message the client cannot parse.
  assert.deepEqual(toProtoValue(Number.NaN), { numberValue: 0 });
  assert.deepEqual(toProtoValue(Number.POSITIVE_INFINITY), { numberValue: 0 });
});

test('toValueMap converts an argument object, ignoring non-objects', () => {
  assert.deepEqual(toValueMap({ a: 'x', b: 2 }), {
    a: { stringValue: 'x' },
    b: { numberValue: 2 },
  });
  assert.deepEqual(toValueMap(null), {});
  assert.deepEqual(toValueMap(['a']), {});
});

const runRequest = {
  mcpTools: {
    mcpTools: [
      {
        name: 'search_issues',
        description: 'Search the tracker',
        toolName: 'search',
        providerIdentifier: 'tracker-mcp',
        inputSchemaJson: '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}',
      },
    ],
  },
  action: {
    userMessageAction: {
      requestContext: {
        tools: [
          { name: 'from_context', description: 'Declared in the request context', toolName: 'ctx' },
          // A duplicate of the top-level declaration must not appear twice.
          { name: 'search_issues', description: 'duplicate' },
        ],
      },
    },
  },
};

test('MCP tools are read from both places a client may declare them', () => {
  const tools = readMcpTools(runRequest, silent);
  assert.deepEqual(tools.map((tool) => tool.name), ['search_issues', 'from_context']);
});

test('the first declaration of a name wins', () => {
  const tools = readMcpTools(runRequest, silent);
  assert.equal(tools[0].description, 'Search the tracker');
});

test('the declared JSON Schema is parsed and forwarded unchanged', () => {
  const [tool] = readMcpTools(runRequest, silent);
  assert.deepEqual(tool.parameters.required, ['query']);
  const [descriptor] = toMcpDescriptors([tool]);
  assert.equal(descriptor.origin, 'native', 'client-declared tools carry the preservation guarantee');
  assert.deepEqual(descriptor.parameters, tool.parameters);
  assert.equal(descriptor.description, 'Search the tracker');
});

test('an unreadable schema still yields a usable tool', () => {
  // Refusing the tool would remove a capability the user deliberately
  // connected; an open object keeps it callable.
  const tools = readMcpTools({ mcpTools: { mcpTools: [{ name: 'broken', inputSchemaJson: '{oops' }] } }, silent);
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].parameters, { type: 'object', properties: {} });
});

test('a tool with no name is skipped', () => {
  assert.deepEqual(readMcpTools({ mcpTools: { mcpTools: [{ description: 'nameless' }] } }, silent), []);
});

test('an MCP call maps onto mcpToolCall with its server identity', () => {
  const tools = readMcpTools(runRequest, silent);
  const message = toMcpToolCallMessage(
    registry,
    tools,
    { id: 'call_7', name: 'search_issues', argumentsJson: '{"query":"bugs","limit":3}' },
    silent,
  );

  assert.equal(message.toolCallId, 'call_7');
  const args = message.mcpToolCall.args;
  assert.equal(args.name, 'search_issues');
  assert.equal(args.toolName, 'search');
  assert.equal(args.providerIdentifier, 'tracker-mcp');
  assert.equal(args.toolCallId, 'call_7');
  assert.deepEqual(args.args, { query: { stringValue: 'bugs' }, limit: { numberValue: 3 } });
});

test('a name that is not an MCP tool falls through', () => {
  const tools = readMcpTools(runRequest, silent);
  assert.equal(
    toMcpToolCallMessage(registry, tools, { id: 'x', name: 'read', argumentsJson: '{}' }, silent),
    null,
  );
});

test('malformed arguments do not throw', () => {
  const tools = readMcpTools(runRequest, silent);
  const message = toMcpToolCallMessage(
    registry,
    tools,
    { id: 'x', name: 'search_issues', argumentsJson: 'not json' },
    silent,
  );
  assert.deepEqual(message.mcpToolCall.args.args, {});
});

test('the call is refused when the schema cannot encode Value', () => {
  // Delivering an MCP tool call with no arguments would do the wrong thing
  // rather than nothing, so it is dropped instead.
  const tools = readMcpTools(runRequest, silent);
  assert.equal(
    toMcpToolCallMessage(bare, tools, { id: 'x', name: 'search_issues', argumentsJson: '{"a":1}' }, silent),
    null,
  );
});
