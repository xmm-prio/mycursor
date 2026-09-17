/**
 * Converting between JSON and `google.protobuf.Value`.
 *
 * Cursor carries MCP tool arguments as `map<string, google.protobuf.Value>`,
 * while a model returns them as JSON. Without this conversion an MCP tool
 * call can be recognised but not delivered, which is the difference between
 * "MCP works under BYOK" and "MCP silently does nothing".
 *
 * `Value` is a oneof, so a converted value sets exactly one field; the codec
 * writes whichever is present.
 */

import type { DescriptorRegistry } from './descriptor.js';
import type { MessageValue } from './message-codec.js';

export const VALUE_TYPE = 'google.protobuf.Value';
export const STRUCT_TYPE = 'google.protobuf.Struct';
export const LIST_VALUE_TYPE = 'google.protobuf.ListValue';

/** True when the registry knows the types this module needs. */
export function hasStructTypes(registry: DescriptorRegistry): boolean {
  return registry.has(VALUE_TYPE) && registry.has(STRUCT_TYPE) && registry.has(LIST_VALUE_TYPE);
}

/** Wraps a JSON value as a `google.protobuf.Value` message. */
export function toProtoValue(value: unknown): MessageValue {
  if (value === null || value === undefined) return { nullValue: 0 };
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return { numberValue: Number.isFinite(value) ? value : 0 };
  if (typeof value === 'string') return { stringValue: value };
  if (Array.isArray(value)) {
    return { listValue: { values: value.map((item) => toProtoValue(item)) } };
  }
  if (typeof value === 'object') {
    const fields: Record<string, MessageValue> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      fields[key] = toProtoValue(item);
    }
    return { structValue: { fields } };
  }
  // Functions and symbols cannot cross the wire; a string is the honest
  // fallback and keeps the argument visible rather than dropping it.
  return { stringValue: String(value) };
}

/** Unwraps a `google.protobuf.Value` message back to JSON. */
export function fromProtoValue(value: MessageValue | undefined): unknown {
  if (!value) return null;
  if (value['stringValue'] !== undefined) return value['stringValue'];
  if (value['boolValue'] !== undefined) return value['boolValue'];
  if (value['numberValue'] !== undefined) return value['numberValue'];
  if (value['nullValue'] !== undefined) return null;

  const struct = value['structValue'] as MessageValue | undefined;
  if (struct) {
    const fields = (struct['fields'] as Record<string, MessageValue> | undefined) ?? {};
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(fields)) result[key] = fromProtoValue(item);
    return result;
  }

  const list = value['listValue'] as MessageValue | undefined;
  if (list) {
    const values = (list['values'] as MessageValue[] | undefined) ?? [];
    return values.map((item) => fromProtoValue(item));
  }
  return null;
}

/** Converts a JSON object into the `map<string, Value>` shape the codec writes. */
export function toValueMap(value: unknown): Record<string, MessageValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, MessageValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = toProtoValue(item);
  }
  return result;
}
