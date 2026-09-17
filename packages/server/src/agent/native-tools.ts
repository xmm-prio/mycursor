/**
 * Cursor's native tool catalogue, derived from the installed schema.
 *
 * The agent protocol does not send a tool list with the request. Its tools are
 * *protocol-level*: `agent.v1.ToolCall` is a closed oneof of roughly seventy
 * typed messages — `readToolCall`, `shellToolCall`, `editToolCall` and the
 * rest — and each one's `args` message is that tool's parameter list. The
 * client implements them; the server picks one.
 *
 * That inverts what preserving native tools means on this path. There is no
 * client-declared list to forward, so the server has to supply the tool
 * definitions itself and translate a model's tool call back into the right
 * typed message. Deriving both from the extracted descriptors — rather than
 * hardcoding seventy schemas — is what keeps the catalogue matched to the
 * installed Cursor version, and what makes a tool added in a later release
 * appear without any change here.
 */

import type { ToolDescriptor } from '@mycursor/core/tools';
import {
  ScalarType,
  type DescriptorRegistry,
  type FieldDescriptor,
  type MessageValue,
} from '@mycursor/protocol/schema';

/** The oneof that enumerates every native tool. */
export const TOOL_CALL_TYPE = 'agent.v1.ToolCall';

/** Fields of `ToolCall` that are metadata rather than a tool. */
const NOT_A_TOOL = new Set([
  'toolCallId',
  'startedAtMs',
  'completedAtMs',
  'hookAdditionalContexts',
]);

/**
 * Tools that exist in the protocol but must not be offered to a model.
 *
 * These are driven by Cursor's own orchestration rather than chosen during a
 * turn; offering them invites a model to call something the client will not
 * know how to answer.
 */
const NOT_OFFERED = new Set([
  'truncated',
  'mcp_auth',
  'report_bugfix_results',
  'ai_attribution',
  'setup_vm_environment',
  'start_grind_execution',
  'start_grind_planning',
  'fetch_cloud_agent_data',
  'update_pr_code_tour',
  'edit_pr_labels',
  'record_ci_investigation_findings',
  'communicate_update',
  'send_final_summary',
]);

export interface NativeTool {
  /** Name the model sees, e.g. `read`. */
  name: string;
  /** Field on `agent.v1.ToolCall`, e.g. `readToolCall`. */
  oneofField: string;
  /** Message type of the tool's `args`, when it takes any. */
  argsType: string | null;
  parameters: JsonSchema;
}

/**
 * Names a model is likely to reach for instead of the protocol's own.
 *
 * The catalogue names come from the protocol (`readToolCall` -> `read`), but
 * models have Cursor's public tool names in their training data and reach for
 * those under pressure — `read_file` rather than `read`. A hallucinated name
 * costs the user a wasted turn, so the common ones are accepted. This only
 * affects resolution; the catalogue still advertises one name per tool.
 */
const ALIASES: Record<string, string> = {
  read_file: 'read',
  write_file: 'pi_write',
  edit_file: 'edit',
  search_replace: 'edit',
  apply_patch: 'edit',
  delete_file: 'delete',
  run_terminal_cmd: 'shell',
  run_command: 'shell',
  terminal: 'shell',
  bash: 'shell',
  list_dir: 'ls',
  list_directory: 'ls',
  file_search: 'glob',
  glob_file_search: 'glob',
  grep_search: 'grep',
  ripgrep: 'grep',
  codebase_search: 'sem_search',
  semantic_search: 'sem_search',
  web_search_tool: 'web_search',
  search_web: 'web_search',
  fetch_url: 'web_fetch',
  todo_write: 'update_todos',
  read_lints_tool: 'read_lints',
};

/** Resolves a model-supplied tool name to a catalogue entry. */
export function resolveTool(
  tools: readonly NativeTool[],
  name: string,
): NativeTool | undefined {
  const requested = name.trim();
  const exact = tools.find((tool) => tool.name === requested);
  if (exact) return exact;

  const aliased = ALIASES[requested.toLowerCase()];
  if (aliased) {
    const viaAlias = tools.find((tool) => tool.name === aliased);
    if (viaAlias) return viaAlias;
  }

  // Last resort: compare with separators and common suffixes removed, which
  // catches `readTool`, `read-file` and similar near-misses.
  const normalise = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(tool|file|call)$/g, '');
  const target = normalise(requested);
  return tools.find((tool) => normalise(tool.name) === target);
}

interface JsonSchema {
  type: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  description?: string;
  enum?: string[];
  additionalProperties?: boolean;
}

/** Depth limit for nested argument messages; Cursor's are shallow. */
const MAX_DEPTH = 4;

/** `readToolCall` -> `read`, `semSearchToolCall` -> `sem_search`. */
function toToolName(oneofField: string): string {
  return oneofField
    .replace(/ToolCall$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function scalarSchema(scalar: number): JsonSchema {
  switch (scalar) {
    case ScalarType.BOOL:
      return { type: 'boolean' };
    case ScalarType.STRING:
    case ScalarType.BYTES:
      return { type: 'string' };
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT:
      return { type: 'number' };
    default:
      return { type: 'integer' };
  }
}

function fieldSchema(
  registry: DescriptorRegistry,
  field: FieldDescriptor,
  depth: number,
): JsonSchema | null {
  let schema: JsonSchema | null;

  if (field.kind === 'scalar') {
    schema = scalarSchema(field.scalar ?? ScalarType.STRING);
  } else if (field.kind === 'enum') {
    // Enum values travel as their proto names, which read far better in a
    // prompt than the numbers the wire uses.
    const names = enumNames(registry, field.typeName);
    schema = names.length > 0 ? { type: 'string', enum: names } : { type: 'string' };
  } else if (field.kind === 'message') {
    if (depth >= MAX_DEPTH || !field.typeName) return null;
    const nested = messageSchema(registry, field.typeName, depth + 1);
    schema = nested;
  } else {
    // Maps are absent from the argument messages Cursor defines.
    return null;
  }

  if (!schema) return null;
  return field.repeated ? { type: 'array', items: schema } : schema;
}

function enumNames(registry: DescriptorRegistry, typeName: string | undefined): string[] {
  if (!typeName) return [];
  const names: string[] = [];
  for (let value = 0; value < 64; value += 1) {
    const name = registry.enumValueName(typeName, value);
    if (name) names.push(name);
  }
  return names;
}

function messageSchema(
  registry: DescriptorRegistry,
  typeName: string,
  depth: number,
): JsonSchema | null {
  const fields = registry.message(typeName);
  if (!fields) return null;

  const properties: Record<string, JsonSchema> = {};
  for (const field of fields) {
    const schema = fieldSchema(registry, field, depth);
    if (schema) properties[field.jsonName] = schema;
  }
  if (Object.keys(properties).length === 0) return { type: 'object' };
  return { type: 'object', properties };
}

/**
 * Builds the catalogue.
 *
 * Returns an empty list when the schema has not been extracted, which the
 * caller treats as "cannot serve this turn" rather than "no tools" — a model
 * told it has no tools would answer with prose where the user expects an edit.
 */
export function buildNativeTools(registry: DescriptorRegistry): NativeTool[] {
  const toolCall = registry.message(TOOL_CALL_TYPE);
  if (!toolCall) return [];

  const tools: NativeTool[] = [];
  for (const field of toolCall) {
    if (field.kind !== 'message' || !field.typeName) continue;
    if (NOT_A_TOOL.has(field.jsonName)) continue;
    if (!field.jsonName.endsWith('ToolCall')) continue;

    const name = toToolName(field.jsonName);
    if (NOT_OFFERED.has(name)) continue;

    const callFields = registry.message(field.typeName);
    if (!callFields) continue;
    const argsField = callFields.find((entry) => entry.jsonName === 'args');
    const argsType = argsField?.kind === 'message' ? (argsField.typeName ?? null) : null;

    const parameters = argsType
      ? (messageSchema(registry, argsType, 0) ?? { type: 'object' })
      : { type: 'object' };

    tools.push({ name, oneofField: field.jsonName, argsType, parameters });
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));
  return tools;
}

/** Converts the catalogue into the descriptors the tool registry consumes. */
export function toToolDescriptors(tools: readonly NativeTool[]): ToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: `Cursor native tool: ${tool.name}`,
    parameters: { ...tool.parameters, additionalProperties: false },
    origin: 'native' as const,
    raw: { oneofField: tool.oneofField, argsType: tool.argsType },
  }));
}

/**
 * Turns a model's tool call back into a `ToolCall` message.
 *
 * Arguments the tool does not declare are dropped rather than passed through:
 * the codec would ignore them anyway, and silently sending a field the client
 * cannot read is worse than calling the tool with what it does understand.
 */
export function toToolCallMessage(
  registry: DescriptorRegistry,
  tools: readonly NativeTool[],
  call: { id: string; name: string; argumentsJson: string },
): MessageValue | null {
  const tool = resolveTool(tools, call.name);
  if (!tool) return null;

  let args: unknown;
  try {
    args = JSON.parse(call.argumentsJson || '{}');
  } catch {
    args = {};
  }

  const body: MessageValue = { toolCallId: call.id };
  body[tool.oneofField] = {
    args: tool.argsType ? coerceArgs(registry, tool.argsType, args) : {},
  };
  return body;
}

/**
 * Aligns loosely-typed JSON from a model with the argument descriptor.
 *
 * Models return numbers as strings and vice versa often enough that a strict
 * pass-through would drop real arguments; enum names are mapped back to their
 * numbers, which is what the wire format needs.
 */
function coerceArgs(
  registry: DescriptorRegistry,
  typeName: string,
  value: unknown,
): MessageValue {
  const fields = registry.message(typeName);
  if (!fields || !value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  const result: MessageValue = {};

  for (const field of fields) {
    const provided = source[field.jsonName] ?? source[field.name];
    if (provided === undefined || provided === null) continue;

    if (field.repeated) {
      const list = Array.isArray(provided) ? provided : [provided];
      result[field.jsonName] = list
        .map((item) => coerceOne(registry, field, item))
        .filter((item) => item !== undefined);
      continue;
    }
    const coerced = coerceOne(registry, field, provided);
    if (coerced !== undefined) result[field.jsonName] = coerced;
  }

  return result;
}

function coerceOne(registry: DescriptorRegistry, field: FieldDescriptor, value: unknown): unknown {
  if (field.kind === 'message') {
    return field.typeName ? coerceArgs(registry, field.typeName, value) : undefined;
  }
  if (field.kind === 'enum') {
    if (typeof value === 'number') return value;
    const resolved = registry.enumValueNumber(field.typeName ?? '', String(value));
    return resolved ?? 0;
  }

  switch (field.scalar) {
    case ScalarType.BOOL:
      return typeof value === 'boolean' ? value : String(value).toLowerCase() === 'true';
    case ScalarType.STRING:
      return typeof value === 'string' ? value : JSON.stringify(value);
    case ScalarType.DOUBLE:
    case ScalarType.FLOAT: {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    default: {
      const parsed = Number.parseInt(String(value), 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
  }
}
