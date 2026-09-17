/**
 * Descriptor-driven message encoding and decoding.
 *
 * These are the properties the whole schema-backed RPC layer rests on. The two
 * that would cause the worst failures if they regressed are covered
 * explicitly: unknown fields surviving a round trip (without it, decoding a
 * message and re-encoding it silently discards everything the descriptor does
 * not describe), and packed repeated scalars being read correctly (proto3 packs
 * them by default, so getting it wrong mis-reads most numeric lists).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DescriptorRegistry,
  ScalarType,
  UNKNOWN_FIELDS,
  decodeMessage,
  encodeMessage,
  toJsonName,
} from '@mycursor/protocol/schema';
import { WireType, encodeFields, stringField, varintField } from '@mycursor/protocol/wire';

function field(no, name, kind, extra = {}) {
  return { no, name, jsonName: toJsonName(name), kind, ...extra };
}

const registry = DescriptorRegistry.fromDocument({
  $schemaVersion: 1,
  cursorVersion: 'test',
  source: 'unit test',
  extractedAt: new Date(0).toISOString(),
  messages: {
    'test.v1.Inner': [
      field(1, 'label', 'scalar', { scalar: ScalarType.STRING }),
      field(2, 'weight', 'scalar', { scalar: ScalarType.DOUBLE }),
    ],
    'test.v1.Outer': [
      field(1, 'name', 'scalar', { scalar: ScalarType.STRING }),
      field(2, 'enabled', 'scalar', { scalar: ScalarType.BOOL }),
      field(3, 'count', 'scalar', { scalar: ScalarType.INT32 }),
      field(4, 'big', 'scalar', { scalar: ScalarType.INT64 }),
      field(5, 'ratio', 'scalar', { scalar: ScalarType.DOUBLE }),
      field(6, 'blob', 'scalar', { scalar: ScalarType.BYTES }),
      field(7, 'tags', 'scalar', { scalar: ScalarType.STRING, repeated: true }),
      field(8, 'numbers', 'scalar', { scalar: ScalarType.INT32, repeated: true }),
      field(9, 'inner', 'message', { typeName: 'test.v1.Inner' }),
      field(10, 'inners', 'message', { typeName: 'test.v1.Inner', repeated: true }),
      field(11, 'mode', 'enum', { typeName: 'test.v1.Mode' }),
      field(12, 'labels', 'map', {
        map: { key: ScalarType.STRING, value: { kind: 'scalar', scalar: ScalarType.STRING } },
      }),
      field(13, 'children', 'map', {
        map: { key: ScalarType.STRING, value: { kind: 'message', typeName: 'test.v1.Inner' } },
      }),
      field(14, 'signed', 'scalar', { scalar: ScalarType.SINT32 }),
      field(15, 'negative', 'scalar', { scalar: ScalarType.INT32 }),
    ],
  },
  enums: {
    'test.v1.Mode': [
      { no: 0, name: 'MODE_UNSPECIFIED' },
      { no: 2, name: 'MODE_FAST' },
    ],
  },
  services: {
    'test.v1.Thing': {
      DoIt: { name: 'DoIt', kind: 'unary', input: 'test.v1.Outer', output: 'test.v1.Inner' },
      StreamIt: {
        name: 'StreamIt',
        kind: 'server-stream',
        input: 'test.v1.Outer',
        output: 'test.v1.Inner',
      },
    },
  },
});

test('toJsonName converts proto names to the object keys used by the codec', () => {
  assert.equal(toJsonName('request_id'), 'requestId');
  assert.equal(toJsonName('is_long_context_only'), 'isLongContextOnly');
  assert.equal(toJsonName('already'), 'already');
  assert.equal(toJsonName('a_1_b'), 'a1B');
});

test('every scalar kind round trips', () => {
  const value = {
    name: 'hello',
    enabled: true,
    count: 42,
    big: '9007199254740993',
    ratio: 1.5,
    blob: new Uint8Array([1, 2, 255]),
    signed: -7,
    negative: -12345,
  };
  const decoded = decodeMessage(registry, 'test.v1.Outer', encodeMessage(registry, 'test.v1.Outer', value));

  assert.equal(decoded.name, 'hello');
  assert.equal(decoded.enabled, true);
  assert.equal(decoded.count, 42);
  // 64-bit values travel as strings so no precision is lost in JavaScript.
  assert.equal(decoded.big, '9007199254740993');
  assert.equal(decoded.ratio, 1.5);
  assert.deepEqual([...decoded.blob], [1, 2, 255]);
  assert.equal(decoded.signed, -7);
  assert.equal(decoded.negative, -12345);
});

test('repeated strings and packed repeated numbers both round trip', () => {
  const value = { tags: ['a', 'b', 'c'], numbers: [1, 300, 70000] };
  const bytes = encodeMessage(registry, 'test.v1.Outer', value);
  const decoded = decodeMessage(registry, 'test.v1.Outer', bytes);

  assert.deepEqual(decoded.tags, ['a', 'b', 'c']);
  assert.deepEqual(decoded.numbers, [1, 300, 70000]);
});

test('an unpacked repeated scalar is accepted too', () => {
  // A conforming encoder may send each element as its own field; a decoder that
  // only understands the packed form would mis-read it.
  const unpacked = encodeFields([varintField(8, 1), varintField(8, 2), varintField(8, 3)]);
  const decoded = decodeMessage(registry, 'test.v1.Outer', unpacked);
  assert.deepEqual(decoded.numbers, [1, 2, 3]);
});

test('nested and repeated messages round trip', () => {
  const value = {
    inner: { label: 'one', weight: 0.5 },
    inners: [{ label: 'a' }, { label: 'b', weight: 2 }],
  };
  const decoded = decodeMessage(registry, 'test.v1.Outer', encodeMessage(registry, 'test.v1.Outer', value));

  assert.equal(decoded.inner.label, 'one');
  assert.equal(decoded.inner.weight, 0.5);
  assert.equal(decoded.inners.length, 2);
  assert.equal(decoded.inners[1].label, 'b');
  assert.equal(decoded.inners[1].weight, 2);
});

test('maps with scalar and message values round trip', () => {
  const value = {
    labels: { first: 'one', second: 'two' },
    children: { a: { label: 'child-a' }, b: { label: 'child-b', weight: 3 } },
  };
  const decoded = decodeMessage(registry, 'test.v1.Outer', encodeMessage(registry, 'test.v1.Outer', value));

  assert.deepEqual(decoded.labels, { first: 'one', second: 'two' });
  assert.equal(decoded.children.a.label, 'child-a');
  assert.equal(decoded.children.b.weight, 3);
});

test('enum values travel as numbers, including ones the schema does not name', () => {
  const decoded = decodeMessage(
    registry,
    'test.v1.Outer',
    encodeMessage(registry, 'test.v1.Outer', { mode: 2 }),
  );
  assert.equal(decoded.mode, 2);

  // proto3 requires an unknown enum value to survive rather than be clamped.
  const unknown = decodeMessage(
    registry,
    'test.v1.Outer',
    encodeMessage(registry, 'test.v1.Outer', { mode: 99 }),
  );
  assert.equal(unknown.mode, 99);
});

test('unknown fields survive a decode, edit and re-encode cycle', () => {
  // A field the descriptor does not describe, as a newer Cursor would send.
  const withExtra = encodeFields([stringField(1, 'original'), stringField(999, 'from-the-future')]);

  const decoded = decodeMessage(registry, 'test.v1.Outer', withExtra);
  assert.equal(decoded.name, 'original');
  assert.equal(decoded[UNKNOWN_FIELDS].length, 1);
  assert.equal(decoded[UNKNOWN_FIELDS][0].number, 999);

  decoded.name = 'edited';
  const reencoded = encodeMessage(registry, 'test.v1.Outer', decoded);
  const again = decodeMessage(registry, 'test.v1.Outer', reencoded);

  assert.equal(again.name, 'edited');
  assert.equal(again[UNKNOWN_FIELDS].length, 1, 'the unknown field must not be dropped');
  assert.equal(
    new TextDecoder().decode(again[UNKNOWN_FIELDS][0].bytes),
    'from-the-future',
    'the unknown field must keep its value',
  );
});

test('keys the descriptor does not declare are ignored rather than mis-encoded', () => {
  const bytes = encodeMessage(registry, 'test.v1.Outer', {
    name: 'kept',
    supportsTelepathy: true,
  });
  const decoded = decodeMessage(registry, 'test.v1.Outer', bytes);
  assert.equal(decoded.name, 'kept');
  assert.equal(decoded.supportsTelepathy, undefined);
  assert.equal(decoded[UNKNOWN_FIELDS], undefined);
});

test('an absent field stays absent rather than becoming a default', () => {
  const decoded = decodeMessage(
    registry,
    'test.v1.Outer',
    encodeMessage(registry, 'test.v1.Outer', { name: 'only' }),
  );
  assert.equal(decoded.name, 'only');
  assert.equal(decoded.enabled, undefined);
  assert.equal(decoded.count, undefined);
});

test('encoding an unknown message type is refused', () => {
  assert.throws(() => encodeMessage(registry, 'test.v1.Missing', {}), /no descriptor/);
  assert.throws(() => decodeMessage(registry, 'test.v1.Missing', new Uint8Array()), /no descriptor/);
});

test('the registry exposes method signatures and cardinality', () => {
  assert.equal(registry.method('test.v1.Thing', 'DoIt')?.kind, 'unary');
  assert.equal(registry.method('test.v1.Thing', 'StreamIt')?.kind, 'server-stream');
  assert.equal(registry.method('test.v1.Thing', 'DoIt')?.output, 'test.v1.Inner');
  assert.equal(registry.method('test.v1.Thing', 'Nope'), undefined);
  assert.equal(registry.methodCount, 2);
});

test('registry stats report dangling type references', () => {
  const broken = DescriptorRegistry.fromDocument({
    $schemaVersion: 1,
    cursorVersion: 'test',
    source: 'unit test',
    extractedAt: new Date(0).toISOString(),
    messages: { 'test.v1.A': [field(1, 'b', 'message', { typeName: 'test.v1.Gone' })] },
    enums: {},
    services: {},
  });
  assert.equal(broken.stats().danglingReferences, 1);
});

test('an empty registry reports nothing and refuses lookups gracefully', () => {
  const empty = DescriptorRegistry.empty();
  assert.equal(empty.has('anything'), false);
  assert.equal(empty.method('a.B', 'C'), undefined);
  assert.equal(empty.stats().messages, 0);
});

test('a field whose message type is missing keeps its bytes intact', () => {
  const partial = DescriptorRegistry.fromDocument({
    $schemaVersion: 1,
    cursorVersion: 'test',
    source: 'unit test',
    extractedAt: new Date(0).toISOString(),
    messages: {
      'test.v1.Holder': [field(1, 'payload', 'message', { typeName: 'test.v1.Absent' })],
    },
    enums: {},
    services: {},
  });

  const innerBytes = encodeFields([stringField(1, 'opaque')]);
  const outer = encodeFields([{ number: 1, type: WireType.LengthDelimited, bytes: innerBytes }]);

  const decoded = decodeMessage(partial, 'test.v1.Holder', outer);
  // The payload could not be interpreted, so it is carried as raw fields.
  assert.equal(decoded.payload[UNKNOWN_FIELDS].length, 1);

  const reencoded = encodeMessage(partial, 'test.v1.Holder', decoded);
  assert.deepEqual([...reencoded], [...outer], 'opaque payloads must re-encode byte for byte');
});
