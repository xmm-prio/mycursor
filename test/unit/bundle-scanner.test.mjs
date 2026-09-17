/**
 * The reader that recovers field tables from Cursor's minified bundles.
 *
 * The snippets below are the real shapes `@bufbuild/protobuf` code generation
 * produces, copied from Cursor 3.14.7 and trimmed. Getting any of them wrong
 * means a field is dropped or mis-typed, which produces a response the client
 * misparses — a failure that looks like a network problem rather than a bug
 * here, so it is worth pinning precisely.
 *
 * The extractor as a whole is validated far more strongly than this: its
 * output was compared field by field against an independent encoding of the
 * same schema, 18,279 fields with no disagreement on any name, number, type or
 * cardinality. That comparison needs an external download, so it is recorded
 * in the verification report rather than run here.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  matchBracket,
  parseArray,
  parseObject,
  readIdentifierBackwards,
  readStringLiteral,
  referencedIdentifier,
  tryReadStringLiteral,
} from '@mycursor/patcher';

test('matchBracket spans nested brackets and ignores brackets inside strings', () => {
  const text = 'f([{a:[1,2]},{b:"]]]"}])';
  const end = matchBracket(text, 1);
  assert.equal(text.slice(1, end), '([{a:[1,2]},{b:"]]]"}])'.slice(0, end - 1));
  assert.equal(text[end - 1], ')');
});

test('readStringLiteral handles escapes', () => {
  assert.deepEqual(readStringLiteral('"a\\"b"', 0), { value: 'a"b', end: 6 });
  assert.equal(readStringLiteral("'plain'", 0).value, 'plain');
});

test('readIdentifierBackwards finds the assigned variable', () => {
  const text = 'var loe=e.makeMessageType("x")';
  assert.equal(readIdentifierBackwards(text, text.indexOf('=')), 'loe');
});

test('minified booleans are read as booleans', () => {
  const parsed = parseObject('{repeated:!0,opt:!1}', 0).value;
  assert.equal(parsed.repeated, true);
  assert.equal(parsed.opt, false);
});

test('a scalar field table parses with its numeric type', () => {
  // Real shape, from aiserver.v1.AvailableModelsResponse.AvailableModel.
  const table = '[{no:1,name:"name",kind:"scalar",T:9},{no:2,name:"default_on",kind:"scalar",T:8}]';
  const fields = parseArray(table, 0).value;

  assert.equal(fields.length, 2);
  assert.deepEqual(fields[0], { no: 1, name: 'name', kind: 'scalar', T: 9 });
  assert.equal(fields[1].name, 'default_on');
  assert.equal(fields[1].T, 8);
});

test('a message reference parses as a resolvable identifier', () => {
  const fields = parseArray('[{no:2,name:"models",kind:"message",T:Toe,repeated:!0}]', 0).value;
  assert.equal(fields[0].kind, 'message');
  assert.equal(referencedIdentifier(fields[0].T), 'Toe');
  assert.equal(fields[0].repeated, true);
});

test('an enum reference parses through its getEnumType call', () => {
  // Enums are wrapped: `T: e.getEnumType(Lne)`.
  const fields = parseArray('[{no:10,name:"scope",kind:"enum",T:e.getEnumType(Lne),opt:!0}]', 0).value;
  assert.equal(fields[0].kind, 'enum');
  assert.equal(referencedIdentifier(fields[0].T), 'Lne');
  assert.equal(fields[0].opt, true);
});

test('a map field parses its key type and nested value spec', () => {
  const fields = parseArray(
    '[{no:16,name:"subagent_model_configs",kind:"map",K:9,V:{kind:"message",T:ln}}]',
    0,
  ).value;
  assert.equal(fields[0].kind, 'map');
  assert.equal(fields[0].K, 9);
  assert.equal(fields[0].V.kind, 'message');
  assert.equal(referencedIdentifier(fields[0].V.T), 'ln');
});

test('a oneof member records its group name', () => {
  // Real shape, from agent.v1.AgentClientMessage.
  const fields = parseArray(
    '[{no:1,name:"run_request",kind:"message",T:Rq,oneof:"message"},{no:4,name:"conversation_action",kind:"message",T:Ca,oneof:"message"}]',
    0,
  ).value;
  assert.equal(fields[0].oneof, 'message');
  assert.equal(fields[1].name, 'conversation_action');
});

test('an enum value table parses', () => {
  const values = parseArray(
    '[{no:0,name:"DEGRADATION_STATUS_UNSPECIFIED",localName:"UNSPECIFIED"},{no:1,name:"DEGRADATION_STATUS_DEGRADED",localName:"DEGRADED"}]',
    0,
  ).value;
  assert.equal(values.length, 2);
  assert.equal(values[1].no, 1);
  assert.equal(values[1].name, 'DEGRADATION_STATUS_DEGRADED');
});

test('a service method table parses its signature and cardinality', () => {
  // Real shape, from aiserver.v1.AiService.
  const methods = parseObject(
    '{availableModels:{name:"AvailableModels",I:Req,O:Res,kind:o.Unary},runSse:{name:"RunSSE",I:Bid,O:Msg,kind:o.ServerStreaming}}',
    0,
  ).value;

  assert.equal(methods.availableModels.name, 'AvailableModels');
  assert.equal(referencedIdentifier(methods.availableModels.I), 'Req');
  assert.equal(referencedIdentifier(methods.availableModels.O), 'Res');
  assert.equal(referencedIdentifier(methods.availableModels.kind), 'o.Unary');
  assert.equal(referencedIdentifier(methods.runSse.kind), 'o.ServerStreaming');
});

test('negative and fractional numbers parse', () => {
  const parsed = parseObject('{a:-5,b:1.5,c:2e3}', 0).value;
  assert.equal(parsed.a, -5);
  assert.equal(parsed.b, 1.5);
  assert.equal(parsed.c, 2000);
});

test('quoted keys parse as well as bare ones', () => {
  const parsed = parseObject('{"no":3,name:"x"}', 0).value;
  assert.equal(parsed.no, 3);
  assert.equal(parsed.name, 'x');
});

test('referencedIdentifier returns null for a non-reference', () => {
  assert.equal(referencedIdentifier(9), null);
  assert.equal(referencedIdentifier('text'), null);
  assert.equal(referencedIdentifier(undefined), null);
});

/*
 * Rejecting what it cannot read.
 *
 * The reader is anchored by textual heuristics, so a codegen change in a new
 * Cursor release will point it at something that is not a field table. It
 * must fail on that input rather than spin: this exact case took a reported
 * `mycursor schema` on Cursor 3.19.19 to a 4 GB heap death after 33 seconds,
 * because `parseValue` returned without consuming and the array loop had no
 * progress check. Each of these would pass trivially if the guard were
 * removed and the loop merely got slower, so they assert termination.
 */

test('a value the reader has no rule for is rejected, not looped over', () => {
  // `)` reaches no branch in parseValue, which used to return end === index.
  assert.throws(() => parseArray('[{no:1,name:"a"},)]', 0), /unexpected "\)"/);
});

test('a key position that is neither a string nor an identifier is rejected', () => {
  assert.throws(() => parseObject('{no:1,)}', 0), /unexpected/);
});

test('a key with no value is rejected', () => {
  assert.throws(() => parseObject('{no:1,name}', 0), /expected ":"/);
});

test('an unclosed literal is rejected rather than scanned to the end', () => {
  assert.throws(() => parseArray(`[${'{no:1},'.repeat(100)}`, 0), /never closed/);
  assert.throws(() => parseObject(`{a:1,${'b:2,'.repeat(100)}`, 0), /never closed/);
});

test('pathological nesting is rejected before it builds a tree', () => {
  assert.throws(() => parseArray(`${'['.repeat(200)}1${']'.repeat(200)}`, 0), /nested too deeply/);
});

test('matchBracket gives up rather than scanning megabytes for a missing close', () => {
  // A mis-anchored bracket used to be matched against one far away, making
  // every bad site cost a scan of the whole bundle.
  const runaway = `[${'x'.repeat(400_000)}]`;
  assert.equal(matchBracket(runaway, 0), -1);
  // A real field table is orders of magnitude smaller and still matches.
  assert.ok(matchBracket(`[${'{no:1},'.repeat(800)}]`, 0) > 0);
});

test('an unterminated string is rejected, not read to the end of the bundle', () => {
  // A quote inside a regular expression or template looks like the start of
  // a literal. Reading to the matching quote — or to the end of a 46 MB
  // bundle when there is none — built that whole span one character at a
  // time, at every anchor the scanner tried.
  const runaway = `"${'x'.repeat(200_000)}`;
  assert.throws(() => readStringLiteral(runaway, 0), /never closed/);
  assert.equal(tryReadStringLiteral(runaway, 0), null);
  // A real type name is unaffected.
  assert.equal(tryReadStringLiteral('"aiserver.v1.Foo"', 0).value, 'aiserver.v1.Foo');
});

test('readIdentifierBackwards does not copy out an arbitrarily long run', () => {
  const blob = `${'A'.repeat(100_000)}=`;
  assert.ok(readIdentifierBackwards(blob, blob.length - 1).length <= 512);
  assert.equal(readIdentifierBackwards('var loe=x', 7), 'loe');
});

test('rejection is confined to the offending literal', () => {
  // The extractor catches these per site, so a bundle with one unreadable
  // table still yields every other table.
  const good = parseArray('[{no:1,name:"a"}]', 0).value;
  assert.equal(good.length, 1);
  assert.throws(() => parseArray('[@]', 0));
  assert.equal(parseArray('[{no:2,name:"b"}]', 0).value[0].name, 'b');
});
