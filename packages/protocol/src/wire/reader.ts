/**
 * Structural protobuf decoding.
 *
 * Cursor's `.proto` definitions are not published, and hardcoding field numbers
 * recovered from one release is how a tool like this becomes a maintenance
 * treadmill. The decoder here therefore reads a message *structurally*: the
 * wire format records a field number and a wire type for every field, which is
 * enough to recover the shape of a message without knowing its schema.
 *
 * Two things fall out of that. Unknown messages can be inspected and logged,
 * which is what makes the schema recorder possible; and a message can be
 * re-encoded byte-for-byte after a targeted edit, leaving the fields this
 * toolkit does not understand untouched.
 */

export enum WireType {
  Varint = 0,
  Fixed64 = 1,
  LengthDelimited = 2,
  StartGroup = 3,
  EndGroup = 4,
  Fixed32 = 5,
}

/** One occurrence of one field, in the order it appeared. */
export interface WireField {
  number: number;
  type: WireType;
  /** Varint and fixed values, as a bigint to avoid precision loss. */
  value?: bigint;
  /** Payload of a length-delimited field. */
  bytes?: Uint8Array;
}

export class ProtobufReadError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
    this.name = 'ProtobufReadError';
  }
}

export class WireReader {
  private position = 0;

  constructor(private readonly buffer: Uint8Array) {}

  get offset(): number {
    return this.position;
  }

  get done(): boolean {
    return this.position >= this.buffer.length;
  }

  /** Reads a base-128 varint. */
  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.position >= this.buffer.length) {
        throw new ProtobufReadError('truncated varint', this.position);
      }
      const byte = this.buffer[this.position]!;
      this.position += 1;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 70n) throw new ProtobufReadError('varint overflows 64 bits', this.position);
    }
  }

  readFixed32(): bigint {
    if (this.position + 4 > this.buffer.length) {
      throw new ProtobufReadError('truncated fixed32', this.position);
    }
    let value = 0n;
    for (let i = 3; i >= 0; i -= 1) value = (value << 8n) | BigInt(this.buffer[this.position + i]!);
    this.position += 4;
    return value;
  }

  readFixed64(): bigint {
    if (this.position + 8 > this.buffer.length) {
      throw new ProtobufReadError('truncated fixed64', this.position);
    }
    let value = 0n;
    for (let i = 7; i >= 0; i -= 1) value = (value << 8n) | BigInt(this.buffer[this.position + i]!);
    this.position += 8;
    return value;
  }

  readBytes(): Uint8Array {
    const length = Number(this.readVarint());
    if (length < 0 || this.position + length > this.buffer.length) {
      throw new ProtobufReadError('length-delimited field exceeds buffer', this.position);
    }
    const slice = this.buffer.subarray(this.position, this.position + length);
    this.position += length;
    return slice;
  }

  /** Reads the next field, or null at the end of the buffer. */
  readField(): WireField | null {
    if (this.done) return null;
    const tag = this.readVarint();
    const number = Number(tag >> 3n);
    const type = Number(tag & 7n) as WireType;
    if (number <= 0) throw new ProtobufReadError(`illegal field number ${number}`, this.position);

    switch (type) {
      case WireType.Varint:
        return { number, type, value: this.readVarint() };
      case WireType.Fixed64:
        return { number, type, value: this.readFixed64() };
      case WireType.Fixed32:
        return { number, type, value: this.readFixed32() };
      case WireType.LengthDelimited:
        return { number, type, bytes: this.readBytes() };
      case WireType.StartGroup:
      case WireType.EndGroup:
        // Groups are deprecated and absent from Cursor's traffic; refusing them
        // is safer than guessing at nesting.
        throw new ProtobufReadError(`unsupported group wire type ${type}`, this.position);
      default:
        throw new ProtobufReadError(`unknown wire type ${type}`, this.position);
    }
  }
}

/** Reads every field of a message, preserving order and repeats. */
export function decodeFields(buffer: Uint8Array): WireField[] {
  const reader = new WireReader(buffer);
  const fields: WireField[] = [];
  for (;;) {
    const field = reader.readField();
    if (!field) return fields;
    fields.push(field);
  }
}

/**
 * Best-effort test for whether a length-delimited payload is itself a message.
 *
 * The wire format cannot distinguish a nested message from a string, so the
 * heuristic is "it decodes cleanly and consumes every byte". Used only by the
 * schema recorder for presentation; nothing depends on it for correctness.
 */
export function looksLikeMessage(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  try {
    const reader = new WireReader(bytes);
    let count = 0;
    for (;;) {
      const field = reader.readField();
      if (!field) break;
      count += 1;
      if (count > 512) return false;
    }
    return count > 0 && reader.done;
  } catch {
    return false;
  }
}
