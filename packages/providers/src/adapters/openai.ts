/**
 * OpenAI Chat Completions adapter.
 *
 * Written against the wire format rather than the vendor SDK, which is what
 * lets the same adapter serve every OpenAI-compatible endpoint — DeepSeek,
 * OpenRouter, Groq, Together, a local vLLM — by changing only the base URL.
 * The alternative, one adapter per vendor, would multiply the same code by the
 * number of services that copied the schema.
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

interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: OpenAiToolCallDelta[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAiProvider implements Provider {
  readonly kind = 'openai' as const;

  constructor(private readonly config: ProviderConfig) {}

  get id(): string {
    return this.config.id;
  }

  get models(): ProviderModel[] {
    return this.config.models;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.authValue}`,
      ...(this.config.headers ?? {}),
    };
  }

  async listModels(signal?: AbortSignal): Promise<CatalogEntry[]> {
    const response = await call({
      url: `${effectiveBaseUrl(this.config)}/models`,
      method: 'GET',
      headers: this.headers(),
      proxyUrl: this.config.proxyUrl,
      signal,
      retries: 1,
      timeoutMs: 20_000,
    });
    const body = await readJson<{ data?: { id?: string; context_window?: number }[] }>(response.stream);
    return (body.data ?? [])
      .filter((entry): entry is { id: string } => typeof entry.id === 'string')
      .map((entry) => ({ id: entry.id }));
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const model = this.config.models.find((entry) => entry.id === request.model);
    const body = {
      model: model?.apiModel ?? request.model,
      messages: request.messages.map(toOpenAiMessage),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
      // An empty tool array is rejected by some compatible services, so the
      // key is omitted rather than sent empty.
      ...(request.tools.length > 0
        ? { tools: request.tools.map(toOpenAiTool), tool_choice: 'auto' }
        : {}),
    };

    const response = await call({
      url: `${effectiveBaseUrl(this.config)}/chat/completions`,
      headers: { accept: 'text/event-stream', ...this.headers() },
      body,
      proxyUrl: this.config.proxyUrl,
      signal: request.signal,
    });

    // Tool call arguments arrive in fragments keyed by index; a call is only
    // emitted once the stream says the turn is over.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: ChatEvent | null = null;

    for await (const event of parseSse(response.stream)) {
      if (event.data === '[DONE]') break;
      let chunk: OpenAiChunk;
      try {
        chunk = JSON.parse(event.data) as OpenAiChunk;
      } catch {
        continue;
      }

      if (chunk.error?.message) throw new Error(chunk.error.message);

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (delta?.content) yield { type: 'text', delta: delta.content };
      const reasoning = delta?.reasoning_content ?? delta?.reasoning;
      if (reasoning) yield { type: 'reasoning', delta: reasoning };

      for (const toolCall of delta?.tool_calls ?? []) {
        const slot = pending.get(toolCall.index) ?? { id: '', name: '', args: '' };
        if (toolCall.id) slot.id = toolCall.id;
        if (toolCall.function?.name) slot.name = toolCall.function.name;
        if (toolCall.function?.arguments) slot.args += toolCall.function.arguments;
        pending.set(toolCall.index, slot);
      }

      if (chunk.usage) {
        yield {
          type: 'usage',
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }

      if (choice?.finish_reason) finish = { type: 'done', reason: mapFinishReason(choice.finish_reason) };
    }

    for (const [index, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      yield {
        type: 'tool-call',
        call: { id: slot.id || `call_${index}`, name: slot.name, argumentsJson: slot.args || '{}' },
      };
    }

    yield finish ?? { type: 'done', reason: pending.size > 0 ? 'tool-calls' : 'stop' };
  }
}

function mapFinishReason(reason: string): 'stop' | 'length' | 'tool-calls' {
  switch (reason) {
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls';
    default:
      return 'stop';
  }
}

function toOpenAiTool(tool: { name: string; description?: string; parameters?: unknown }): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      parameters: tool.parameters ?? { type: 'object', properties: {} },
    },
  };
}

function toOpenAiMessage(message: ChatMessage): unknown {
  if (message.role === 'tool') {
    return { role: 'tool', tool_call_id: message.toolCallId, content: textOf(message) };
  }

  if (message.role === 'assistant' && message.toolCalls?.length) {
    return {
      role: 'assistant',
      content: textOf(message) || null,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: 'function',
        function: { name: toolCall.name, arguments: toolCall.argumentsJson },
      })),
    };
  }

  // Multimodal turns need the array form; plain text uses the string form,
  // which a few compatible services still require.
  const hasImage = message.content.some((part) => part.type === 'image');
  if (!hasImage) return { role: message.role, content: textOf(message) };

  return {
    role: message.role,
    content: message.content.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.dataBase64}` } },
    ),
  };
}

function textOf(message: ChatMessage): string {
  return message.content
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
