/**
 * Translating between Cursor's agent protocol and the internal turn model.
 *
 * Two directions, both driven entirely by the schema recovered from the
 * installed Cursor:
 *
 *  - **ingress** takes the `AgentClientMessage` that arrives inside a
 *    `BidiAppend` and produces an `AgentTurn` — conversation history, the new
 *    user message, the requested model, and the native tool catalogue;
 *  - **egress** turns the provider's flat event stream into the
 *    `AgentServerMessage` frames `RunSSE` streams back.
 *
 * The conversation itself is typed rather than opaque: `ConversationHistory`
 * models user, assistant and tool messages with text, image, reasoning and
 * tool-call content, which maps almost one-to-one onto the internal model. The
 * one real impedance mismatch is tool calls, which the protocol expresses as a
 * closed oneof of typed messages rather than a name and arguments — see
 * `native-tools.ts` for why that inverts how tools are preserved here.
 */

import type { ToolPolicyConfig } from '@mycursor/core/config';
import type { Logger } from '@mycursor/core/logging';
import {
  decodeMessage,
  encodeMessage,
  type DescriptorRegistry,
  type MessageValue,
} from '@mycursor/protocol/schema';
import type { ChatMessage, ContentPart, ToolCall } from '@mycursor/providers';

import {
  readMcpTools,
  toMcpDescriptors,
  toMcpToolCallMessage,
  type McpTool,
} from './mcp-tools.js';
import { buildNativeTools, toToolCallMessage, toToolDescriptors, type NativeTool } from './native-tools.js';
import {
  buildSystemPrompt,
  readTurnContext,
  resolveSubagent,
  type TurnContext,
} from './request-context.js';
import type { AgentTurn, TurnEvent } from './turn.js';

export const CLIENT_MESSAGE_TYPE = 'agent.v1.AgentClientMessage';
export const SERVER_MESSAGE_TYPE = 'agent.v1.AgentServerMessage';
export const BIDI_APPEND_REQUEST_TYPE = 'aiserver.v1.BidiAppendRequest';
export const BIDI_APPEND_RESPONSE_TYPE = 'aiserver.v1.BidiAppendResponse';
export const BIDI_REQUEST_ID_TYPE = 'aiserver.v1.BidiRequestId';

/** Types the bridge cannot work without. */
const REQUIRED_TYPES = [
  CLIENT_MESSAGE_TYPE,
  SERVER_MESSAGE_TYPE,
  BIDI_APPEND_REQUEST_TYPE,
  'agent.v1.AgentRunRequest',
  'agent.v1.ConversationHistory',
  'agent.v1.InteractionUpdate',
  'agent.v1.ToolCall',
];

export function isAgentProtocolAvailable(registry: DescriptorRegistry): boolean {
  return REQUIRED_TYPES.every((type) => registry.has(type));
}

// ------------------------------------------------------------- ingress ----

export interface DecodedRun {
  turn: AgentTurn;
  conversationId: string;
  /** The catalogue the egress side needs to map tool calls back. */
  nativeTools: NativeTool[];
  /** MCP tools the client declared, which map onto a single message type. */
  mcpTools: McpTool[];
  /** Rules, skills and custom subagents attached to the turn. */
  context: TurnContext;
}

/** Reads the request id a `BidiAppend` is correlated by. */
export function readAppendRequestId(
  registry: DescriptorRegistry,
  body: Uint8Array,
): { requestId: string; payload: Uint8Array | null } | null {
  if (!registry.has(BIDI_APPEND_REQUEST_TYPE)) return null;
  try {
    const request = decodeMessage(registry, BIDI_APPEND_REQUEST_TYPE, body);
    const requestId = String(
      (request['requestId'] as MessageValue | undefined)?.['requestId'] ?? '',
    );
    if (!requestId) return null;

    // The client message rides in `dataBinary`; `data` carries the same thing
    // as text on transports that cannot hold bytes.
    const binary = request['dataBinary'];
    if (binary instanceof Uint8Array && binary.length > 0) return { requestId, payload: binary };
    const text = request['data'];
    if (typeof text === 'string' && text.length > 0) {
      return { requestId, payload: Buffer.from(text, 'base64') };
    }
    return { requestId, payload: null };
  } catch {
    return null;
  }
}

/** Reads the request id `RunSSE` opens its stream for. */
export function readRunRequestId(registry: DescriptorRegistry, body: Uint8Array): string | null {
  if (!registry.has(BIDI_REQUEST_ID_TYPE)) return null;
  try {
    const decoded = decodeMessage(registry, BIDI_REQUEST_ID_TYPE, body);
    const requestId = String(decoded['requestId'] ?? '');
    return requestId || null;
  } catch {
    return null;
  }
}

export interface DecodeOptions {
  registry: DescriptorRegistry;
  policy: ToolPolicyConfig;
  logger: Logger;
}

/**
 * Turns a client message into a turn, or null when it is not a run request.
 *
 * A client may send several messages on one request id — heartbeats, context
 * injections, a conversation action before the run request. Only the run
 * request starts a turn.
 */
export function decodeRunRequest(options: DecodeOptions, payload: Uint8Array): DecodedRun | null {
  const { registry, logger } = options;
  let client: MessageValue;
  try {
    client = decodeMessage(registry, CLIENT_MESSAGE_TYPE, payload);
  } catch (error) {
    logger.debug('client message could not be decoded', { error: (error as Error).message });
    return null;
  }

  const runRequest = client['runRequest'] as MessageValue | undefined;
  if (!runRequest) return null;

  const action = runRequest['action'] as MessageValue | undefined;
  const userAction = action?.['userMessageAction'] as MessageValue | undefined;
  const userMessage = userAction?.['userMessage'] as MessageValue | undefined;

  const history = userAction?.['conversationHistory'] as MessageValue | undefined;
  const messages = toChatMessages(history);

  // The newest user message arrives outside the history, so it is appended.
  const latest = String(userMessage?.['text'] ?? '').trim();
  if (latest) messages.push({ role: 'user', content: [{ type: 'text', text: latest }] });

  if (messages.length === 0) {
    logger.debug('run request carried no conversation content');
    return null;
  }

  const context = readTurnContext(runRequest, logger);
  const subagentRun = resolveSubagent(runRequest, context);

  const requested = runRequest['requestedModel'] as MessageValue | undefined;
  const details = runRequest['modelDetails'] as MessageValue | undefined;
  // A subagent the user gave its own model runs on that model, not on the
  // conversation's; ignoring the choice sends every subagent to the main
  // model, which is slower and more expensive than what they asked for.
  const model = (
    subagentRun.modelId ??
    String(requested?.['modelId'] ?? details?.['modelId'] ?? '')
  ).trim();
  if (!model) {
    logger.debug('run request named no model');
    return null;
  }

  const nativeTools = buildNativeTools(registry);
  const mcpTools = readMcpTools(runRequest, logger);

  // Protocol tools come first so a name collision resolves in favour of
  // Cursor's own tool; the registry keeps the first declaration of a name.
  let descriptors = [...toToolDescriptors(nativeTools), ...toMcpDescriptors(mcpTools)];

  // A custom subagent may be restricted to a subset of tools. Honouring that
  // is a safety property: a read-only subagent must not be handed `shell`.
  const allowed = subagentRun.subagent?.tools ?? [];
  if (allowed.length > 0) {
    const permitted = new Set(allowed);
    descriptors = descriptors.filter((descriptor) => permitted.has(descriptor.name));
    logger.debug('subagent restricts the tool set', {
      subagent: subagentRun.subagent?.name,
      allowed: descriptors.length,
    });
  }

  const systemPrompt = buildSystemPrompt({
    customSystemPrompt: String(runRequest['customSystemPrompt'] ?? '').trim(),
    subagent: subagentRun.subagent,
    context,
  });
  if (systemPrompt) messages.unshift({ role: 'system', content: [{ type: 'text', text: systemPrompt }] });

  const turn: AgentTurn = { model, messages, nativeTools: descriptors };
  const effort = readReasoningEffort(requested);
  if (effort) turn.reasoningEffort = effort;

  if (mcpTools.length > 0 || context.rules.length > 0 || context.skills.length > 0) {
    logger.debug('turn context assembled', {
      protocolTools: nativeTools.length,
      mcpTools: mcpTools.length,
      rules: context.rules.length,
      skills: context.skills.length,
      subagent: subagentRun.subagent?.name ?? null,
      modelSource: subagentRun.reason,
    });
  }

  return {
    turn,
    conversationId: String(runRequest['conversationId'] ?? ''),
    nativeTools,
    mcpTools,
    context,
  };
}

/** Reads the reasoning level out of the quick-switch parameter values. */
function readReasoningEffort(
  requested: MessageValue | undefined,
): 'low' | 'medium' | 'high' | undefined {
  const parameters = requested?.['parameters'];
  if (!Array.isArray(parameters)) return undefined;
  for (const entry of parameters as MessageValue[]) {
    if (String(entry['id'] ?? '') !== 'reasoning_effort') continue;
    const value = String(entry['value'] ?? '').toLowerCase();
    if (value === 'low' || value === 'medium' || value === 'high') return value;
    // `minimal` and `max` are this toolkit's own labels; map them onto the
    // three levels every provider understands.
    if (value === 'minimal') return 'low';
    if (value === 'max') return 'high';
  }
  return undefined;
}

function toChatMessages(history: MessageValue | undefined): ChatMessage[] {
  const entries = history?.['messages'];
  if (!Array.isArray(entries)) return [];

  const messages: ChatMessage[] = [];
  for (const entry of entries as MessageValue[]) {
    const user = entry['user'] as MessageValue | undefined;
    if (user) {
      messages.push({ role: 'user', content: toContentParts(user['content']) });
      continue;
    }

    const assistant = entry['assistant'] as MessageValue | undefined;
    if (assistant) {
      const content: ContentPart[] = [];
      const toolCalls: ToolCall[] = [];
      for (const part of asList(assistant['content'])) {
        const text = part['text'] as MessageValue | undefined;
        if (text) content.push({ type: 'text', text: String(text['text'] ?? '') });
        // Reasoning is intentionally not replayed: providers reject foreign
        // reasoning blocks, and it is not part of the conversation contract.
        const call = part['toolCall'] as MessageValue | undefined;
        if (call) {
          toolCalls.push({
            id: String(call['toolCallId'] ?? ''),
            name: String(call['toolName'] ?? ''),
            argumentsJson: String(call['argsJson'] ?? '{}'),
          });
        }
      }
      messages.push({
        role: 'assistant',
        content,
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
      });
      continue;
    }

    const tool = entry['tool'] as MessageValue | undefined;
    if (tool) {
      messages.push({
        role: 'tool',
        content: toContentParts(tool['content']),
        toolCallId: String(tool['toolCallId'] ?? ''),
      });
    }
  }
  return messages;
}

function asList(value: unknown): MessageValue[] {
  return Array.isArray(value) ? (value as MessageValue[]) : [];
}

function toContentParts(value: unknown): ContentPart[] {
  const parts: ContentPart[] = [];
  for (const entry of asList(value)) {
    const text = entry['text'] as MessageValue | undefined;
    if (text) {
      parts.push({ type: 'text', text: String(text['text'] ?? '') });
      continue;
    }
    const image = entry['image'] as MessageValue | undefined;
    if (image) {
      parts.push({
        type: 'image',
        mediaType: String(image['mimeType'] ?? 'image/png'),
        dataBase64: String(image['data'] ?? ''),
      });
    }
  }
  return parts;
}

// -------------------------------------------------------------- egress ----

export interface EgressOptions {
  registry: DescriptorRegistry;
  nativeTools: readonly NativeTool[];
  mcpTools: readonly McpTool[];
  logger: Logger;
}

/**
 * Encodes one provider event as a server message, or null when the event has
 * no counterpart in the protocol.
 */
export function encodeEvent(options: EgressOptions, event: TurnEvent): Uint8Array | null {
  const update = toInteractionUpdate(options, event);
  if (!update) return null;
  return encodeMessage(options.registry, SERVER_MESSAGE_TYPE, { interactionUpdate: update });
}

function toInteractionUpdate(options: EgressOptions, event: TurnEvent): MessageValue | null {
  switch (event.type) {
    case 'turn-start':
      return null;

    case 'server-tool': {
      // The client never saw this call — the server ran it — so there is no
      // tool card in the UI to explain the pause. A notice line is what tells
      // the user their question triggered a web search.
      const query = readQuery(event.argumentsJson);
      return {
        textDelta: {
          text: `\n[mycursor: ${event.name}${query ? ` — ${query}` : ''}]\n`,
          isServerNotice: true,
        },
      };
    }

    case 'text':
      return { textDelta: { text: event.delta } };

    case 'reasoning':
      return { thinkingDelta: { text: event.delta } };

    case 'tool-call': {
      // MCP first: its names come from the user's own servers and must not be
      // swallowed by the protocol catalogue's fuzzy name resolution.
      const toolCall =
        toMcpToolCallMessage(options.registry, options.mcpTools, event.call, options.logger) ??
        toToolCallMessage(options.registry, options.nativeTools, event.call);
      if (!toolCall) {
        // A name the protocol has no message for cannot be delivered; saying
        // so as text beats dropping it silently, because the user can see the
        // model tried.
        options.logger.warn('model called a tool the protocol does not define', {
          tool: event.call.name,
        });
        return { textDelta: { text: `\n[mycursor: unknown tool "${event.call.name}"]\n` } };
      }
      return {
        toolCallStarted: {
          callId: event.call.id,
          modelCallId: event.call.id,
          toolCall,
        },
      };
    }

    case 'usage':
      return { tokenDelta: { tokens: event.outputTokens } };

    case 'error':
      return { textDelta: { text: `\n[mycursor: ${event.message}]\n`, isServerNotice: true } };

    case 'done':
      return null;

    default:
      return null;
  }
}

/** Pulls the query or URL out of a server tool call, for the notice line. */
function readQuery(argumentsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsJson || '{}');
    if (!parsed || typeof parsed !== 'object') return '';
    const args = parsed as Record<string, unknown>;
    return String(args['query'] ?? args['url'] ?? '').slice(0, 120);
  } catch {
    return '';
  }
}

/** The frame that closes a turn, carrying the usage totals. */
export function encodeTurnEnded(
  registry: DescriptorRegistry,
  usage: { inputTokens: number; outputTokens: number },
): Uint8Array {
  return encodeMessage(registry, SERVER_MESSAGE_TYPE, {
    interactionUpdate: {
      turnEnded: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
    },
  });
}

/** The acknowledgement `BidiAppend` returns. */
export function encodeAppendResponse(registry: DescriptorRegistry): Uint8Array {
  return registry.has(BIDI_APPEND_RESPONSE_TYPE)
    ? encodeMessage(registry, BIDI_APPEND_RESPONSE_TYPE, {})
    : new Uint8Array();
}
