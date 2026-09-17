/**
 * Anthropic Messages adapter.
 *
 * Two structural differences from the OpenAI shape drive most of this file:
 * the system prompt is a top-level parameter rather than a message, and
 * content is a block list, so tool calls and tool results are blocks inside a
 * turn instead of separate messages. Both are normalised here so the agent
 * loop above sees the same flat event stream either way.
 */

import { effectiveBaseUrl } from '../defaults.js';
import { call, readJson } from '../transport/http.js';
import { parseSse } from '../transport/sse.js';
import type {
  CatalogEntry,
  ChatEvent,
  ChatMessage,
  ChatRequest,
  Provider,
  ProviderConfig,
  ProviderModel,
} from '../types.js';

const API_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8_192;

interface AnthropicEvent {
  type: string;
  index?: number;
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string;
  };
  content_block?: { type?: string; id?: string; name?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

export class AnthropicProvider implements Provider {
  readonly kind = 'anthropic' as const;

  constructor(private readonly config: ProviderConfig) {}

  get id(): string {
    return this.config.id;
  }

  get models(): ProviderModel[] {
    return this.config.models;
  }

  private headers(): Record<string, string> {
    return {
      'x-api-key': this.config.authValue,
      'anthropic-version': API_VERSION,
      ...(this.config.headers ?? {}),
    };
  }

  async listModels(signal?: AbortSignal): Promise<CatalogEntry[]> {
    const response = await call({
      url: `${effectiveBaseUrl(this.config)}/models?limit=100`,
      method: 'GET',
      headers: this.headers(),
      proxyUrl: this.config.proxyUrl,
      signal,
      retries: 1,
      timeoutMs: 20_000,
    });
    const body = await readJson<{ data?: { id?: string; display_name?: string }[] }>(response.stream);
    return (body.data ?? [])
      .filter((entry): entry is { id: string; display_name?: string } => typeof entry.id === 'string')
      .map((entry) => ({
        id: entry.id,
        ...(entry.display_name ? { displayName: entry.display_name } : {}),
      }));
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const model = this.config.models.find((entry) => entry.id === request.model);
    const { system, messages } = splitSystem(request.messages);

    const body = {
      model: model?.apiModel ?? request.model,
      max_tokens: request.maxOutputTokens ?? model?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      ...(system ? { system } : {}),
      messages,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.tools.length > 0 ? { tools: request.tools.map(toAnthropicTool) } : {}),
      ...(request.reasoningEffort && model?.capabilities.thinking
        ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget(request.reasoningEffort) } }
        : {}),
    };

    const response = await call({
      url: `${effectiveBaseUrl(this.config)}/messages`,
      headers: { accept: 'text/event-stream', ...this.headers() },
      body,
      proxyUrl: this.config.proxyUrl,
      signal: request.signal,
    });
    const stream = response.stream;

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let reason: 'stop' | 'length' | 'tool-calls' = 'stop';

    for await (const event of parseSse(stream)) {
      let payload: AnthropicEvent;
      try {
        payload = JSON.parse(event.data) as AnthropicEvent;
      } catch {
        continue;
      }

      switch (payload.type) {
        case 'error':
          throw new Error(payload.error?.message ?? 'anthropic stream error');

        case 'message_start':
          if (payload.message?.usage) {
            yield {
              type: 'usage',
              inputTokens: payload.message.usage.input_tokens ?? 0,
              outputTokens: payload.message.usage.output_tokens ?? 0,
            };
          }
          break;

        case 'content_block_start':
          if (payload.content_block?.type === 'tool_use' && payload.index !== undefined) {
            pending.set(payload.index, {
              id: payload.content_block.id ?? `call_${payload.index}`,
              name: payload.content_block.name ?? '',
              args: '',
            });
          }
          break;

        case 'content_block_delta': {
          if (payload.delta?.text) yield { type: 'text', delta: payload.delta.text };
          if (payload.delta?.thinking) yield { type: 'reasoning', delta: payload.delta.thinking };
          if (payload.delta?.partial_json !== undefined && payload.index !== undefined) {
            const slot = pending.get(payload.index);
            if (slot) slot.args += payload.delta.partial_json;
          }
          break;
        }

        case 'message_delta':
          if (payload.delta?.stop_reason) reason = mapStopReason(payload.delta.stop_reason);
          if (payload.usage) {
            yield {
              type: 'usage',
              inputTokens: payload.usage.input_tokens ?? 0,
              outputTokens: payload.usage.output_tokens ?? 0,
            };
          }
          break;

        case 'message_stop':
          break;

        default:
          break;
      }
    }

    for (const [index, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool-call',
        call: { id: slot.id, name: slot.name, argumentsJson: slot.args || '{}' },
      };
    }

    yield { type: 'done', reason: pending.size > 0 ? 'tool-calls' : reason };
  }
}

function thinkingBudget(effort: 'low' | 'medium' | 'high'): number {
  return effort === 'high' ? 16_384 : effort === 'medium' ? 8_192 : 2_048;
}

function mapStopReason(reason: string): 'stop' | 'length' | 'tool-calls' {
  switch (reason) {
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool-calls';
    default:
      return 'stop';
  }
}

function toAnthropicTool(tool: { name: string; description?: string; parameters?: unknown }): unknown {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input_schema: tool.parameters ?? { type: 'object', properties: {} },
  };
}

/**
 * Splits the system prompt out and folds tool results into user turns.
 *
 * Anthropic requires alternating user/assistant turns, so consecutive tool
 * results have to be merged into a single user message rather than sent as
 * separate ones.
 */
function splitSystem(messages: readonly ChatMessage[]): { system: string; messages: unknown[] } {
  const systemParts: string[] = [];
  const converted: { role: 'user' | 'assistant'; content: unknown[] }[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(textOf(message));
      continue;
    }

    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: textOf(message),
      };
      const last = converted[converted.length - 1];
      if (last?.role === 'user') last.content.push(block);
      else converted.push({ role: 'user', content: [block] });
      continue;
    }

    const blocks: unknown[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) blocks.push({ type: 'text', text: part.text });
      } else {
        blocks.push({
          type: 'image',
          source: { type: 'base64', media_type: part.mediaType, data: part.dataBase64 },
        });
      }
    }
    for (const call of message.toolCalls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.name,
        input: safeJson(call.argumentsJson),
      });
    }
    if (blocks.length === 0) continue;

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const last = converted[converted.length - 1];
    if (last?.role === role) last.content.push(...blocks);
    else converted.push({ role, content: blocks });
  }

  return { system: systemParts.join('\n\n'), messages: converted };
}

function safeJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function textOf(message: ChatMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
