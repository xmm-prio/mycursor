/**
 * Descriptor-driven message encoding and decoding.
 *
 * Turns protobuf bytes into plain JavaScript objects keyed by camelCase field
 * name, and back. That is what lets a handler read `request.requestId` and
 * build `{ models: [...] }` without any generated code, using a schema
 * recovered from the installed Cursor at runtime.
 *
 * Two properties matter for correctness against a real client:
 *
 *  - **unknown fields survive a round trip.** A field the descriptor does not
 *    describe is kept as raw wire data and re-emitted, so decoding a request,
 *    editing one field and re-encoding it does not silently drop everything
 *    else. Without this, forwarding a modified request upstream would corrupt
 *    it.
 *  - **packed and unpacked repeated scalars are both accepted.** proto3 packs
 *    numeric scalars by default, but a conforming encoder may not, and a
 *    decoder that assumes one form mis-reads the other.
 */

import {
  WireType,
  WireReader,
  WireWriter,
  decodeFields,
  type WireField,
} from '../wire/index.js';
import {
  ScalarType,
  type DescriptorRegistry,
  type FieldDescriptor,
  type MapValueDescriptor,
  type ScalarTypeNumber,
} from './descriptor.js';

export class CodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodecError';
  }
}

/** Raw wire data for fields the descriptor does not describe. */
export const UNKNOWN_FIELDS = '$unknown';

export type MessageValue = Record<string, unknown> & { [UNKNOWN_FIELDS]?: WireField[] };

// ------------------------------------------------------------------ decoding --

export function decodeMessage(
  registry: DescriptorRegistry,
  typeName: string,
  bytes: Uint8Array,
): MessageValue {
  const fields = registry.message(typeName);
  if (!fields) throw new CodecError(`no descriptor for message ${typeName}`);

  const byNumber = new Map<number, FieldDescriptor>();
  for (const field of fields) byNumber.set(field.no, field);

  const result: MessageValue = {};
  const unknown: WireField[] = [];

  for (const wire of decodeFields(bytes)) {
    const field = byNumber.get(wire.number);
    if (!field) {
      unknown.push(wire);
      continue;
    }
    applyDecodedField(registry, result, field, wire);
  }

  if (unknown.length > 0) result[UNKNOWN_FIELDS] = unknown;
  return result;
}

function applyDecodedField(
  registry: DescriptorRegistry,
  target: MessageValue,
  field: FieldDescriptor,
  wire: WireField,
): void {
  if (field.kind === 'map') {
    const map = (target[field.jsonName] as Record<string, unknown>) ?? {};
    const entry = decodeMapEntry(registry, field, wire);
    if (entry) map[entry.key] = entry.value;
    target[field.jsonName] = map;
    return;
  }

  if (field.repeated) {
    const list = (target[field.jsonName] as unknown[]) ?? [];
    // A packed repeated scalar arrives as one length-delimited field holding
    // every element, so it has to be expanded rather than appended.
    if (field.kind !== 'message' && wire.type === WireType.LengthDelimited && isPackable(field)) {
      list.push(...unpackScalars(field, wire.bytes ?? new Uint8Array()));
    } else {
      list.push(decodeSingle(registry, field, wire));
    }
    target[field.jsonName] = list;
    return;
  }

  target[field.jsonName] = decodeSingle(registry, field, wire);
}

function decodeSingle(
  registry: DescriptorRegistry,
  field: FieldDescriptor,
  wire: WireField,
): unknown {
  if (field.kind === 'message') {
    if (!field.typeName) throw new CodecError(`message field ${field.name} has no type name`);
    if (!registry.has(field.typeName)) {
      // The descriptor set is incomplete for this branch; keep the bytes so a
      // re-encode is still lossless.
      return { [UNKNOWN_FIELDS]: decodeFields(wire.bytes ?? new Uint8Array()) };
    }
    return decodeMessage(registry, field.typeName, wire.bytes ?? new Uint8Array());
  }
  if (field.kind === 'enum') {
    const value = Number(wire.value ?? 0n);
    // Numbers are kept rather than names: an unknown enum value must survive,
    // and proto3 requires exactly that.
    return value;
  }
  return decodeScalar(field.scalar ?? ScalarType.STRING, wire);
}

function decodeMapEntry(
  registry: DescriptorRegistry,
  field: FieldDescriptor,
  wire: WireField,
): { key: string; value: unknown } | null {
  if (!field.map) return null;
  // A map entry is a synthetic message with key = 1 and value = 2.
  let key: unknown = defaultScalar(field.map.key);
  let value: unknown = defaultMapValue(field.map.value);

  for (const entry of decodeFields(wire.bytes ?? new Uint8Array())) {
    if (entry.number === 1) key = decodeScalar(field.map.key, entry);
    else if (entry.number === 2) value = decodeMapValue(registry, field.map.value, entry);
  }
  return { key: String(key), value };
}

function decodeMapValue(
  registry: DescriptorRegistry,
  descriptor: MapValueDescriptor,
  wire: WireField,
): unknown {
  if (descriptor.kind === 'message') {
    if (!descriptor.typeName || !registry.has(descriptor.typeName)) {
      return { [UNKNOWN_FIELDS]: decodeFields(wire.bytes ?? new Uint8Array()) };
    }
    return decodeMessage(registry, descriptor.typeName, wire.bytes ?? new Uint8Array());
  }
  if (descriptor.kind === 'enum') return Number(wire.value ?? 0n);
  return decodeScalar(descriptor.scalar ?? ScalarType.STRING, wire);
}

function decodeScalar(type: ScalarTypeNumber, wire: WireField): unknown {
  switch (type) {
    case ScalarType.BOOL:
      return (wire.value ?? 0n) !== 0n;
    case ScalarType.STRING:
      return new TextDecoder().decode(wire.bytes ?? new Uint8Array());
    case ScalarType.BYTES:
      return wire.bytes ?? new Uint8Array();
    case ScalarType.DOUBLE:
      return bitsToFloat(wire.value ?? 0n, 8);
    case ScalarType.FLOAT:
      return bitsToFloat(wire.value ?? 0n, 4);
    case ScalarType.INT32:
    case ScalarType.SFIXED32:
      return asSigned32(wire.value ?? 0n);
    case ScalarType.UINT32:
    case ScalarType.FIXED32:
      return Number(wire.value ?? 0n);
    case ScalarType.SINT32:
      return zigZagDecode(wire.value ?? 0n, 32);
    case ScalarType.SINT64:
      return String(zigZagDecode64(wire.value ?? 0n));
    case ScalarType.INT64:
    case ScalarType.SFIXED64:
      // 64-bit values become strings, the same choice protobuf JSON makes, so
      // no precision is lost on the way through JavaScript.
      return String(asSigned64(wire.value ?? 0n));
    case ScalarType.UINT64:
    case ScalarType.FIXED64:
      return String(wire.value ?? 0n);
    default:
      return Number(wire.value ?? 0n);
  }
}

/** Expands a packed repeated scalar payload. */
function unpackScalars(field: FieldDescriptor, bytes: Uint8Array): unknown[] {
  const type = field.scalar ?? (field.kind === 'enum' ? ScalarType.INT32 : ScalarType.STRING);
  const reader = new WireReader(bytes);
  const values: unknown[] = [];
  while (!reader.done) {
    if (isFixed64(type)) values.push(decodeScalar(type, { number: field.no, type: WireType.Fixed64, value: reader.readFixed64() }));
    else if (isFixed32(type)) values.push(decodeScalar(type, { number: field.no, type: WireType.Fixed32, value: reader.readFixed32() }));
    else values.push(decodeScalar(type, { number: field.no, type: WireType.Varint, value: reader.readVarint() }));
  }
  return values;
}

// ------------------------------------------------------------------ encoding --

export function encodeMessage(
  registry: DescriptorRegistry,
  typeName: string,
  value: MessageValue,
): Uint8Array {
  const fields = registry.message(typeName);
  if (!fields) throw new CodecError(`no descriptor for message ${typeName}`);

  const writer = new WireWriter();
  for (const field of fields) {
    const provided = value[field.jsonName];
    if (provided === undefined || provided === null) continue;
    encodeField(registry, writer, field, provided);
  }

  // Unknown fields are written last so their relative order is preserved.
  const unknown = value[UNKNOWN_FIELDS];
  if (Array.isArray(unknown)) {
    for (const wire of unknown) writer.writeField(wire);
  }

  return writer.finish();
}

function encodeField(
  registry: DescriptorRegistry,
  writer: WireWriter,
  field: FieldDescriptor,
  value: unknown,
): void {
  if (field.kind === 'map') {
    if (!field.map || typeof value !== 'object') return;
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const entry = new WireWriter();
      writeScalar(entry, 1, field.map.key, coerceMapKey(field.map.key, key));
      writeMapValue(registry, entry, 2, field.map.value, entryValue);
      writer.writeTag(field.no, WireType.LengthDelimited);
      writer.writeBytes(entry.finish());
    }
    return;
  }

  if (field.repeated) {
    const list = Array.isArray(value) ? value : [value];
    if (field.kind === 'message') {
      for (const item of list) writeMessageField(registry, writer, field, item);
      return;
    }
    if (isPackable(field)) {
      // Pack numeric scalars, which is proto3's default and what a client
      // expects to receive.
      const packed = new WireWriter();
      for (const item of list) writeScalarBody(packed, scalarTypeOf(field), item);
      const bytes = packed.finish();
      if (bytes.length === 0) return;
      writer.writeTag(field.no, WireType.LengthDelimited);
      writer.writeBytes(bytes);
      return;
    }
    for (const item of list) writeScalar(writer, field.no, scalarTypeOf(field), item);
    return;
  }

  if (field.kind === 'message') {
    writeMessageField(registry, writer, field, value);
    return;
  }
  writeScalar(writer, field.no, scalarTypeOf(field), value);
}

function writeMessageField(
  registry: DescriptorRegistry,
  writer: WireWriter,
  field: FieldDescriptor,
  value: unknown,
): void {
  if (!field.typeName) throw new CodecError(`message field ${field.name} has no type name`);
  const bytes =
    registry.has(field.typeName) && isPlainObject(value)
      ? encodeMessage(registry, field.typeName, value as MessageValue)
      : encodeUnknownOnly(value);
  writer.writeTag(field.no, WireType.LengthDelimited);
  writer.writeBytes(bytes);
}

function writeMapValue(
  registry: DescriptorRegistry,
  writer: WireWriter,
  no: number,
  descriptor: MapValueDescriptor,
  value: unknown,
): void {
  if (descriptor.kind === 'message') {
    const bytes =
      descriptor.typeName && registry.has(descriptor.typeName) && isPlainObject(value)
        ? encodeMessage(registry, descriptor.typeName, value as MessageValue)
        : encodeUnknownOnly(value);
    writer.writeTag(no, WireType.LengthDelimited);
    writer.writeBytes(bytes);
    return;
  }
  writeScalar(writer, no, descriptor.scalar ?? ScalarType.STRING, value);
}

function encodeUnknownOnly(value: unknown): Uint8Array {
  if (isPlainObject(value)) {
    const unknown = (value as MessageValue)[UNKNOWN_FIELDS];
    if (Array.isArray(unknown)) {
      const writer = new WireWriter();
      for (const wire of unknown) writer.writeField(wire);
      return writer.finish();
    }
  }
  return new Uint8Array();
}

function writeScalar(
  writer: WireWriter,
  no: number,
  type: ScalarTypeNumber,
  value: unknown,
): void {
  if (isFixed64(type)) {
    writer.writeTag(no, WireType.Fixed64);
  } else if (isFixed32(type)) {
    writer.writeTag(no, WireType.Fixed32);
  } else if (type === ScalarType.STRING || type === ScalarType.BYTES) {
    writer.writeTag(no, WireType.LengthDelimited);
  } else {
    writer.writeTag(no, WireType.Varint);
  }
  writeScalarBody(writer, type, value);
}

function writeScalarBody(writer: WireWriter, type: ScalarTypeNumber, value: unknown): void {
  switch (type) {
    case ScalarType.BOOL:
      writer.writeVarint(value ? 1 : 0);
      return;
    case ScalarType.STRING:
      writer.writeBytes(new TextEncoder().encode(String(value ?? '')));
      return;
    case ScalarType.BYTES:
      writer.writeBytes(value instanceof Uint8Array ? value : new Uint8Array());
      return;
    case ScalarType.DOUBLE:
      writer.writeFixed64(floatToBits(Number(value ?? 0), 8));
      return;
    case ScalarType.FLOAT:
      writer.writeFixed32(floatToBits(Number(value ?? 0), 4));
      return;
    case ScalarType.FIXED32:
    case ScalarType.SFIXED32:
      writer.writeFixed32(BigInt(Math.trunc(Number(value ?? 0))) & 0xffffffffn);
      return;
    case ScalarType.FIXED64:
    case ScalarType.SFIXED64:
      writer.writeFixed64(toBigInt(value) & ((1n << 64n) - 1n));
      return;
    case ScalarType.SINT32:
      writer.writeVarint(zigZagEncode(BigInt(Math.trunc(Number(value ?? 0)))));
      return;
    case ScalarType.SINT64:
      writer.writeVarint(zigZagEncode(toBigInt(value)));
      return;
    default:
      writer.writeVarint(toBigInt(value));
  }
}

// ------------------------------------------------------------------- helpers --

function scalarTypeOf(field: FieldDescriptor): ScalarTypeNumber {
  if (field.kind === 'enum') return ScalarType.INT32;
  return field.scalar ?? ScalarType.STRING;
}

/** Numeric scalars and enums are packable; strings, bytes and messages are not. */
function isPackable(field: FieldDescriptor): boolean {
  if (field.kind === 'message' || field.kind === 'map') return false;
  const type = scalarTypeOf(field);
  return type !== ScalarType.STRING && type !== ScalarType.BYTES;
}

const isFixed64 = (type: ScalarTypeNumber): boolean =>
  type === ScalarType.DOUBLE ||
  type === ScalarType.FIXED64 ||
  type === ScalarType.SFIXED64;

const isFixed32 = (type: ScalarTypeNumber): boolean =>
  type === ScalarType.FLOAT ||
  type === ScalarType.FIXED32 ||
  type === ScalarType.SFIXED32;

function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);
}

function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(Math.trunc(value));
  if (typeof value === 'boolean') return value ? 1n : 0n;
  const text = String(value ?? '0').trim();
  try {
    return BigInt(text === '' ? '0' : text);
  } catch {
    return 0n;
  }
}

function coerceMapKey(type: ScalarTypeNumber, key: string): unknown {
  if (type === ScalarType.STRING) return key;
  if (type === ScalarType.BOOL) return key === 'true';
  return Number(key);
}

function defaultScalar(type: ScalarTypeNumber): unknown {
  if (type === ScalarType.STRING) return '';
  if (type === ScalarType.BOOL) return false;
  return 0;
}

function defaultMapValue(descriptor: MapValueDescriptor): unknown {
  if (descriptor.kind === 'message') return {};
  if (descriptor.kind === 'enum') return 0;
  return defaultScalar(descriptor.scalar ?? ScalarType.STRING);
}

function asSigned32(value: bigint): number {
  const masked = Number(value & 0xffffffffn);
  return masked > 0x7fffffff ? masked - 0x100000000 : masked;
}

function asSigned64(value: bigint): bigint {
  const masked = value & ((1n << 64n) - 1n);
  return masked > (1n << 63n) - 1n ? masked - (1n << 64n) : masked;
}

function zigZagEncode(value: bigint): bigint {
  const masked = value < 0n ? value + (1n << 64n) : value;
  const sign = value < 0n ? -1n : 0n;
  return ((masked << 1n) ^ sign) & ((1n << 64n) - 1n);
}

function zigZagDecode(value: bigint, bits: number): number {
  const decoded = (value >> 1n) ^ -(value & 1n);
  return bits === 32 ? asSigned32(decoded & 0xffffffffn) : Number(decoded);
}

function zigZagDecode64(value: bigint): bigint {
  return (value >> 1n) ^ -(value & 1n);
}

function bitsToFloat(bits: bigint, bytes: 4 | 8): number {
  const view = new DataView(new ArrayBuffer(8));
  if (bytes === 8) {
    view.setBigUint64(0, bits & ((1n << 64n) - 1n), true);
    return view.getFloat64(0, true);
  }
  view.setUint32(0, Number(bits & 0xffffffffn), true);
  return view.getFloat32(0, true);
}

function floatToBits(value: number, bytes: 4 | 8): bigint {
  const view = new DataView(new ArrayBuffer(8));
  if (bytes === 8) {
    view.setFloat64(0, value, true);
    return view.getBigUint64(0, true);
  }
  view.setFloat32(0, value, true);
  return BigInt(view.getUint32(0, true));
}
