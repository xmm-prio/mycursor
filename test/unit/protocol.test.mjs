/**
 * Wire format handling.
 *
 * The structural protobuf codec and the Connect framing are what let the server
 * answer Cursor without its `.proto` files, so the round trips below are the
 * foundation the whole RPC layer stands on.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_MESSAGE,
  WireType,
  boolField,
  decodeFields,
  encodeFields,
  introspect,
  looksLikeMessage,
  messageField,
  stringField,
  varintField,
} from '@mycursor/protocol/wire';
import {
  EnvelopeDecoder,
  FLAG_END_STREAM,
  RpcError,
  decodeEnvelopes,
  encodeEnvelope,
  errorResponse,
  parseContentType,
  unaryResponse,
} from '@mycursor/protocol/connect';
import { lookupMethod } from '@mycursor/protocol/schema';

test('structural encode and decode round trip', () => {
  const fields = [
    varintField(1, 42),
    stringField(2, 'hello wire'),
    boolField(3, true),
    messageField(4, [stringField(1, 'nested')]),
  ];
  const decoded = decodeFields(encodeFields(fields));

  assert.equal(decoded.length, 4);
  assert.equal(decoded[0].number, 1);
  assert.equal(decoded[0].value, 42n);
  assert.equal(new TextDecoder().decode(decoded[1].bytes), 'hello wire');
  assert.equal(decoded[2].value, 1n);
  assert.equal(new TextDecoder().decode(decodeFields(decoded[3].bytes)[0].bytes), 'nested');
});

test('an empty message is valid and decodes to nothing', () => {
  assert.equal(EMPTY_MESSAGE.length, 0);
  assert.deepEqual(decodeFields(EMPTY_MESSAGE), []);
});

test('large field numbers and multi-byte varints survive', () => {
  const fields = [varintField(100_000, 2n ** 40n), stringField(70_000, 'x'.repeat(300))];
  const decoded = decodeFields(encodeFields(fields));
  assert.equal(decoded[0].number, 100_000);
  assert.equal(decoded[0].value, 2n ** 40n);
  assert.equal(decoded[1].bytes.length, 300);
});

test('decoding rejects a truncated message instead of inventing fields', () => {
  const valid = encodeFields([stringField(1, 'abcdefgh')]);
  assert.throws(() => decodeFields(valid.subarray(0, valid.length - 3)));
});

test('looksLikeMessage separates nested messages from plain strings', () => {
  assert.equal(looksLikeMessage(encodeFields([varintField(1, 1)])), true);
  assert.equal(looksLikeMessage(new TextEncoder().encode('just some text here')), false);
  assert.equal(looksLikeMessage(new Uint8Array()), false);
});

test('introspection describes an unknown message', () => {
  const described = introspect(
    encodeFields([stringField(1, 'model-name'), varintField(2, 1), messageField(3, [varintField(1, 7)])]),
  );
  assert.equal(described[0].wireType, 'bytes');
  assert.ok(described[0].candidates.some((candidate) => candidate.includes('model-name')));
  assert.ok(described[1].candidates.some((candidate) => candidate.includes('bool=true')));
  assert.equal(described[2].children?.[0]?.number, 1);
});

test('envelope frames round trip, including across chunk boundaries', () => {
  const first = encodeEnvelope(new TextEncoder().encode('one'));
  const second = encodeEnvelope(new TextEncoder().encode('two'), FLAG_END_STREAM);
  const whole = new Uint8Array([...first, ...second]);

  const frames = decodeEnvelopes(whole);
  assert.equal(frames.length, 2);
  assert.equal(new TextDecoder().decode(frames[0].payload), 'one');
  assert.equal(frames[1].flags, FLAG_END_STREAM);

  // Fed one byte at a time, the decoder must produce the same frames.
  const decoder = new EnvelopeDecoder();
  const collected = [];
  for (const byte of whole) collected.push(...decoder.push(new Uint8Array([byte])));
  assert.equal(collected.length, 2);
  assert.equal(decoder.pendingBytes, 0);
});

test('a body ending mid-frame is reported, not silently truncated', () => {
  const frame = encodeEnvelope(new TextEncoder().encode('incomplete'));
  assert.throws(() => decodeEnvelopes(frame.subarray(0, frame.length - 2)), /mid-frame/);
});

test('content types map to the right protocol and framing', () => {
  assert.deepEqual(parseContentType('application/proto'), {
    protocol: 'connect-unary',
    format: 'proto',
    enveloped: false,
    responseContentType: 'application/proto',
  });
  assert.equal(parseContentType('application/connect+proto').enveloped, true);
  assert.equal(parseContentType('application/grpc-web+proto').protocol, 'grpc-web');
  assert.equal(parseContentType('application/json; charset=utf-8').format, 'json');
  // An unrecognised type must still get a usable answer.
  assert.equal(parseContentType(undefined).protocol, 'connect-unary');
});

test('a unary response over a streaming protocol is framed and terminated', () => {
  const plain = unaryResponse(parseContentType('application/proto'), new Uint8Array([1, 2, 3]));
  assert.equal(plain.body.length, 3);

  const streamed = unaryResponse(parseContentType('application/connect+proto'), new Uint8Array([1]));
  const frames = decodeEnvelopes(streamed.body);
  assert.equal(frames.length, 2);
  assert.equal(frames[1].flags, FLAG_END_STREAM);
});

test('errors are reported the way each protocol expects', () => {
  const error = new RpcError('unavailable', 'server is starting');

  // Unary Connect can use an HTTP status.
  const unary = errorResponse(parseContentType('application/proto'), error);
  assert.equal(unary.status, 503);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(unary.body)), {
    code: 'unavailable',
    message: 'server is starting',
  });

  // Streaming has already sent 200, so the error goes in the body.
  const streamed = errorResponse(parseContentType('application/connect+proto'), error);
  assert.equal(streamed.status, 200);
  assert.equal(decodeEnvelopes(streamed.body)[0].flags, FLAG_END_STREAM);

  // gRPC uses trailers.
  const grpc = errorResponse(parseContentType('application/grpc+proto'), error);
  assert.equal(grpc.trailers['grpc-status'], '14');
});

test('an unexpected throw becomes a retryable code', () => {
  // `unavailable` rather than `internal`, because Cursor retries the former and
  // a local hiccup is almost always transient.
  assert.equal(RpcError.from(new Error('socket closed')).code, 'unavailable');
  assert.equal(RpcError.from(new RpcError('not_found', 'x')).code, 'not_found');
});

test('method lookup defaults to forwarding anything unrecognised', () => {
  assert.equal(lookupMethod('aiserver.v1.AiService', 'AvailableModels').strategy, 'local');
  assert.equal(lookupMethod('aiserver.v1.AuthService', 'AnythingAtAll').strategy, 'empty');
  assert.equal(lookupMethod('aiserver.v1.BrandNewService', 'Method').strategy, 'upstream');
  // A streaming method must not be answered as unary.
  assert.equal(lookupMethod('agent.v1.AgentService', 'RunSSE').cardinality, 'server-stream');
  assert.equal(lookupMethod('aiserver.v1.BidiService', 'BidiAppend').cardinality, 'client-stream');
});
