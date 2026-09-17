/**
 * Structural protobuf encoding.
 *
 * The counterpart to the structural reader: a message is written from a list
 * of wire fields, so a response can be composed without a compiled schema, and
 * a decoded message can be re-encoded with only the fields this toolkit
 * understands changed.
 */

import { WireType, type WireField } from './reader.js';

export class WireWriter {
  private readonly chunks: number[] = [];

  writeVarint(value: bigint | number): this {
    let remaining = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    if (remaining < 0n) {
      // Negative values are encoded as their two's-complement 64-bit form,
      // which is what protobuf does for int32/int64.
      remaining += 1n << 64n;
    }
    do {
      const byte = Number(remaining & 0x7fn);
      remaining >>= 7n;
      this.chunks.push(remaining > 0n ? byte | 0x80 : byte);
    } while (remaining > 0n);
    return this;
  }

  writeTag(fieldNumber: number, type: WireType): this {
    return this.writeVarint((BigInt(fieldNumber) << 3n) | BigInt(type));
  }

  writeFixed32(value: bigint | number): this {
    let remaining = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    for (let i = 0; i < 4; i += 1) {
      this.chunks.push(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    return this;
  }

  writeFixed64(value: bigint | number): this {
    let remaining = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    for (let i = 0; i < 8; i += 1) {
      this.chunks.push(Number(remaining & 0xffn));
      remaining >>= 8n;
    }
    return this;
  }

  writeBytes(bytes: Uint8Array): this {
    this.writeVarint(bytes.length);
    for (const byte of bytes) this.chunks.push(byte);
    return this;
  }

  writeField(field: WireField): this {
    this.writeTag(field.number, field.type);
    switch (field.type) {
      case WireType.Varint:
        return this.writeVarint(field.value ?? 0n);
      case WireType.Fixed64:
        return this.writeFixed64(field.value ?? 0n);
      case WireType.Fixed32:
        return this.writeFixed32(field.value ?? 0n);
      case WireType.LengthDelimited:
        return this.writeBytes(field.bytes ?? new Uint8Array());
      default:
        throw new Error(`cannot encode wire type ${field.type}`);
    }
  }

  finish(): Uint8Array {
    return new Uint8Array(this.chunks);
  }
}

export function encodeFields(fields: readonly WireField[]): Uint8Array {
  const writer = new WireWriter();
  for (const field of fields) writer.writeField(field);
  return writer.finish();
}

/**
 * An empty message.
 *
 * Protobuf gives every field a default, so zero bytes is a valid encoding of
 * any message type. That is what makes it the right response for the account
 * and dashboard endpoints a BYOK session has no real answer for: the client
 * gets a well-formed reply, and no field number has to be guessed.
 */
export const EMPTY_MESSAGE = new Uint8Array();

// Convenience builders for the handful of shapes the stub handlers need.

export function varintField(number: number, value: bigint | number): WireField {
  return { number, type: WireType.Varint, value: BigInt(value) };
}

export function boolField(number: number, value: boolean): WireField {
  return varintField(number, value ? 1 : 0);
}

export function stringField(number: number, value: string): WireField {
  return { number, type: WireType.LengthDelimited, bytes: new TextEncoder().encode(value) };
}

export function bytesField(number: number, value: Uint8Array): WireField {
  return { number, type: WireType.LengthDelimited, bytes: value };
}

export function messageField(number: number, fields: readonly WireField[]): WireField {
  return { number, type: WireType.LengthDelimited, bytes: encodeFields(fields) };
}

export function doubleField(number: number, value: number): WireField {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return { number, type: WireType.Fixed64, value: view.getBigUint64(0, true) };
}
