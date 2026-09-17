/**
 * MCP tools inside an agent turn.
 *
 * Unlike Cursor's protocol tools, MCP tools *are* declared in the request —
 * `AgentRunRequest.mcpTools` carries a name, a description and a JSON Schema
 * for each. They are therefore client-declared in the same sense as the tools
 * on the OpenAI-compatible path, and get the same preservation guarantee:
 * forwarded verbatim, never rewritten.
 *
 * The return trip is the interesting half. Every MCP tool maps onto the single
 * `mcpToolCall` message, distinguished by the `name`, `toolName` and
 * `providerIdentifier` fields, and its arguments travel as
 * `map<string, google.protobuf.Value>` rather than a JSON string. Getting that
 * conversion wrong is the difference between an MCP tool that runs and one
 * that is called with no arguments.
 */

import type { ToolDescriptor } from '@mycursor/core/tools';
import type { Logger } from '@mycursor/core/logging';
import {
  hasStructTypes,
  toValueMap,
  type DescriptorRegistry,
  type MessageValue,
} from '@mycursor/protocol/schema';

/** Field on `agent.v1.ToolCall` that carries every MCP invocation. */
const MCP_ONEOF_FIELD = 'mcpToolCall';

export interface McpTool {
  /** Name the model sees, and the name Cursor matches on. */
  name: string;
  description: string;
  /** Tool name as the MCP server knows it, when it differs. */
  toolName: string;
  providerIdentifier: string;
  parameters: unknown;
}

/**
 * Reads the MCP tools a run request declares.
 *
 * Two places carry them — the top-level `mcpTools` and the request context —
 * and a client may populate either, so both are read and merged by name.
 */
export function readMcpTools(runRequest: MessageValue, logger: Logger): McpTool[] {
  const seen = new Map<string, McpTool>();

  const collect = (definitions: unknown): void => {
    if (!Array.isArray(definitions)) return;
    for (const raw of definitions as MessageValue[]) {
      const name = String(raw['name'] ?? '').trim();
      if (!name || seen.has(name)) continue;

      let parameters: unknown = { type: 'object', properties: {} };
      const schemaJson = String(raw['inputSchemaJson'] ?? '').trim();
      if (schemaJson) {
        try {
          parameters = JSON.parse(schemaJson);
        } catch (error) {
          // A tool with an unreadable schema is still worth offering with an
          // open object; refusing it would remove a capability the user
          // deliberately connected.
          logger.debug('MCP tool has an unreadable input schema', {
            tool: name,
            error: (error as Error).message,
          });
        }
      }

      seen.set(name, {
        name,
        description: String(raw['description'] ?? ''),
        toolName: String(raw['toolName'] ?? name),
        providerIdentifier: String(raw['providerIdentifier'] ?? ''),
        parameters,
      });
    }
  };

  collect((runRequest['mcpTools'] as MessageValue | undefined)?.['mcpTools']);

  const action = runRequest['action'] as MessageValue | undefined;
  const requestContext = (action?.['userMessageAction'] as MessageValue | undefined)?.[
    'requestContext'
  ] as MessageValue | undefined;
  collect(requestContext?.['tools']);

  return [...seen.values()];
}

/**
 * Converts MCP tools into descriptors.
 *
 * Marked `native` because the client declared them: the tool registry must
 * treat them as authoritative and forward their schemas unchanged.
 */
export function toMcpDescriptors(tools: readonly McpTool[]): ToolDescriptor[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
    origin: 'native' as const,
    raw: { mcp: true, toolName: tool.toolName, providerIdentifier: tool.providerIdentifier },
  }));
}

/**
 * Builds the `ToolCall` message for an MCP invocation.
 *
 * Returns null when the name is not an MCP tool, so the caller can fall
 * through to the protocol tool catalogue.
 */
export function toMcpToolCallMessage(
  registry: DescriptorRegistry,
  tools: readonly McpTool[],
  call: { id: string; name: string; argumentsJson: string },
  logger: Logger,
): MessageValue | null {
  const tool = tools.find((entry) => entry.name === call.name);
  if (!tool) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(call.argumentsJson || '{}');
  } catch {
    parsed = {};
  }

  if (!hasStructTypes(registry)) {
    // Without `google.protobuf.Value` the arguments cannot be encoded, and an
    // MCP tool called with none would do the wrong thing rather than nothing.
    logger.warn('MCP tool call dropped: the schema lacks google.protobuf.Value', {
      tool: call.name,
    });
    return null;
  }

  const args: MessageValue = {
    name: tool.name,
    toolName: tool.toolName,
    toolCallId: call.id,
    args: toValueMap(parsed),
  };
  if (tool.providerIdentifier) args['providerIdentifier'] = tool.providerIdentifier;

  return {
    toolCallId: call.id,
    [MCP_ONEOF_FIELD]: { args, ...(tool.description ? { description: tool.description } : {}) },
  };
}

export { MCP_ONEOF_FIELD };
