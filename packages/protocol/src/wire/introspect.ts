/**
 * Turning an unknown message into something a human can read.
 *
 * This is the schema recorder's output format. Because the wire format keeps
 * field numbers and wire types, an observed response can be rendered as a
 * field tree — which is how the descriptor for a Cursor message gets written in
 * the first place, and how a schema drift after an upgrade gets spotted.
 *
 * Nothing in the request path depends on this: it exists so that extending the
 * toolkit to a new endpoint is an act of observation rather than guesswork.
 */

import { decodeFields, looksLikeMessage, WireType, type WireField } from './reader.js';

export interface IntrospectedField {
  number: number;
  wireType: string;
  /** Interpretations consistent with the bytes observed. */
  candidates: string[];
  /** Nested fields, when the payload decodes cleanly as a message. */
  children?: IntrospectedField[];
}

const WIRE_TYPE_NAMES: Record<number, string> = {
  [WireType.Varint]: 'varint',
  [WireType.Fixed64]: 'fixed64',
  [WireType.LengthDelimited]: 'bytes',
  [WireType.Fixed32]: 'fixed32',
};

const MAX_DEPTH = 8;

function describeVarint(value: bigint): string[] {
  const candidates = [`uint64=${value}`];
  if (value === 0n || value === 1n) candidates.push(`bool=${value === 1n}`);
  // ZigZag, used by sint32/sint64.
  const zigzag = (value >> 1n) ^ -(value & 1n);
  if (zigzag !== value) candidates.push(`sint64=${zigzag}`);
  return candidates;
}

function describeBytes(bytes: Uint8Array): string[] {
  const candidates: string[] = [`length=${bytes.length}`];
  const text = tryDecodeUtf8(bytes);
  if (text !== null) candidates.push(`string=${JSON.stringify(truncate(text, 120))}`);
  if (looksLikeMessage(bytes)) candidates.push('message');
  return candidates;
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    // Control characters other than whitespace suggest this was never text.
    return /[\u0000-\u0008\u000e-\u001f]/.test(text) ? null : text;
  } catch {
    return null;
  }
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function describeField(field: WireField, depth: number): IntrospectedField {
  const described: IntrospectedField = {
    number: field.number,
    wireType: WIRE_TYPE_NAMES[field.type] ?? `unknown(${field.type})`,
    candidates: [],
  };

  if (field.type === WireType.Varint) {
    described.candidates = describeVarint(field.value ?? 0n);
  } else if (field.type === WireType.Fixed64) {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, field.value ?? 0n, true);
    described.candidates = [`fixed64=${field.value}`, `double=${view.getFloat64(0, true)}`];
  } else if (field.type === WireType.Fixed32) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, Number(field.value ?? 0n), true);
    described.candidates = [`fixed32=${field.value}`, `float=${view.getFloat32(0, true)}`];
  } else if (field.type === WireType.LengthDelimited) {
    const bytes = field.bytes ?? new Uint8Array();
    described.candidates = describeBytes(bytes);
    if (depth < MAX_DEPTH && looksLikeMessage(bytes)) {
      try {
        described.children = decodeFields(bytes).map((child) => describeField(child, depth + 1));
      } catch {
        // A false positive from the heuristic; the candidates still stand.
      }
    }
  }

  return described;
}

/** Describes every field of a message. */
export function introspect(buffer: Uint8Array): IntrospectedField[] {
  return decodeFields(buffer).map((field) => describeField(field, 0));
}

/** Renders an introspection as an indented tree. */
export function formatIntrospection(fields: readonly IntrospectedField[], indent = 0): string {
  const lines: string[] = [];
  for (const field of fields) {
    lines.push(`${' '.repeat(indent)}#${field.number} ${field.wireType}: ${field.candidates.join(' | ')}`);
    if (field.children) lines.push(formatIntrospection(field.children, indent + 2));
  }
  return lines.filter(Boolean).join('\n');
}
