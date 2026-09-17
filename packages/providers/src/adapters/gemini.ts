/**
 * Google Gemini `streamGenerateContent` adapter.
 *
 * Gemini differs from the other two in three ways that matter here: the model
 * name is part of the URL, tool declarations are grouped under a single
 * `functionDeclarations` entry, and a function call arrives complete in one
 * chunk rather than as argument fragments. The last one simplifies the
 * accumulation logic away entirely.
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

interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name?: string; args?: unknown };
  inlineData?: { mimeType?: string; data?: string };
}

interface GeminiChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; code?: number };
}

export class GeminiProvider implements Provider {
  readonly kind = 'gemini' as const;

  constructor(private readonly config: ProviderConfig) {}

  get id(): string {
    return this.config.id;
  }

  get models(): ProviderModel[] {
    return this.config.models;
  }

  private headers(): Record<string, string> {
    return { 'x-goog-api-key': this.config.authValue, ...(this.config.headers ?? {}) };
  }

  async listModels(signal?: AbortSignal): Promise<CatalogEntry[]> {
    const response = await call({
      url: `${effectiveBaseUrl(this.config)}/models?pageSize=200`,
      method: 'GET',
      headers: this.headers(),
      proxyUrl: this.config.proxyUrl,
      signal,
      retries: 1,
      timeoutMs: 20_000,
    });
    const body = await readJson<{
      models?: { name?: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number }[];
    }>(response.stream);
    return (body.models ?? [])
      .map((entry) => ({
        // Gemini reports `models/gemini-2.5-pro`; the request wants the tail.
        id: String(entry.name ?? '').replace(/^models\//, ''),
        ...(entry.displayName ? { displayName: entry.displayName } : {}),
        ...(entry.inputTokenLimit ? { contextWindow: entry.inputTokenLimit } : {}),
        ...(entry.outputTokenLimit ? { maxOutputTokens: entry.outputTokenLimit } : {}),
      }))
      .filter((entry) => entry.id.length > 0);
  }

  async *streamChat(request: ChatRequest): AsyncIterable<ChatEvent> {
    const model = this.config.models.find((entry) => entry.id === request.model);
    const upstreamModel = model?.apiModel ?? request.model;
    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const body = {
      contents,
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(request.tools.length > 0
        ? { tools: [{ functionDeclarations: request.tools.map(toGeminiFunction) }] }
        : {}),
      generationConfig: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.reasoningEffort && model?.capabilities.thinking
          ? { thinkingConfig: { includeThoughts: true } }
          : {}),
      },
    };

    const response = await call({
      url: `${effectiveBaseUrl(this.config)}/models/${encodeURIComponent(upstreamModel)}:streamGenerateContent?alt=sse`,
      headers: { accept: 'text/event-stream', ...this.headers() },
      body,
      proxyUrl: this.config.proxyUrl,
      signal: request.signal,
    });
    const stream = response.stream;

    let sawToolCall = false;
    let reason: 'stop' | 'length' | 'tool-calls' = 'stop';
    let callIndex = 0;

    for await (const event of parseSse(stream)) {
      let chunk: GeminiChunk;
      try {
        chunk = JSON.parse(event.data) as GeminiChunk;
      } catch {
        continue;
      }

      if (chunk.error?.message) throw new Error(chunk.error.message);

      const candidate = chunk.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        // Gemini flags reasoning with `thought` on an otherwise ordinary text
        // part, so the check has to come first.
        if (part.text && part.thought) yield { type: 'reasoning', delta: part.text };
        else if (part.text) yield { type: 'text', delta: part.text };

        if (part.functionCall?.name) {
          sawToolCall = true;
          callIndex += 1;
          yield {
            type: 'tool-call',
            call: {
              id: `call_${callIndex}`,
              name: part.functionCall.name,
              argumentsJson: JSON.stringify(part.functionCall.args ?? {}),
            },
          };
        }
      }

      if (chunk.usageMetadata) {
        yield {
          type: 'usage',
          inputTokens: chunk.usageMetadata.promptTokenCount ?? 0,
          outputTokens: chunk.usageMetadata.candidatesTokenCount ?? 0,
        };
      }

      if (candidate?.finishReason) reason = mapFinishReason(candidate.finishReason);
    }

    yield { type: 'done', reason: sawToolCall ? 'tool-calls' : reason };
  }
}

function mapFinishReason(reason: string): 'stop' | 'length' | 'tool-calls' {
  // `SAFETY` and `RECITATION` end the turn without an error frame; treating
  // them as a normal stop leaves whatever text arrived intact.
  return reason === 'MAX_TOKENS' ? 'length' : 'stop';
}

function toGeminiFunction(tool: {
  name: string;
  description?: string;
  parameters?: unknown;
}): unknown {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: stripUnsupportedSchema(tool.parameters) ?? { type: 'object', properties: {} },
  };
}

/**
 * Gemini rejects JSON Schema keywords it does not implement, and Cursor's
 * native tool schemas contain several of them. Dropping the unknown keys is
 * what keeps those tools usable on Gemini rather than failing the whole
 * request.
 */
function stripUnsupportedSchema(schema: unknown): unknown {
  const ALLOWED = new Set([
    'type',
    'format',
    'description',
    'nullable',
    'enum',
    'items',
    'properties',
    'required',
    'example',
  ]);

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (!ALLOWED.has(key)) continue;
      result[key] = key === 'properties' ? walkProperties(value) : walk(value);
    }
    return result;
  };

  const walkProperties = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      result[key] = walk(value);
    }
    return result;
  };

  return schema === undefined ? undefined : walk(schema);
}

function toGeminiContents(messages: readonly ChatMessage[]): {
  systemInstruction: unknown | null;
  contents: unknown[];
} {
  const systemParts: unknown[] = [];
  const contents: { role: 'user' | 'model'; parts: unknown[] }[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push({ text: textOf(message) });
      continue;
    }

    if (message.role === 'tool') {
      const part = {
        functionResponse: {
          name: message.toolCallId ?? 'tool',
          response: { content: textOf(message) },
        },
      };
      const last = contents[contents.length - 1];
      if (last?.role === 'user') last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }

    const parts: unknown[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) parts.push({ text: part.text });
      } else {
        parts.push({ inlineData: { mimeType: part.mediaType, data: part.dataBase64 } });
      }
    }
    for (const call of message.toolCalls ?? []) {
      parts.push({ functionCall: { name: call.name, args: safeJson(call.argumentsJson) } });
    }
    if (parts.length === 0) continue;

    const role = message.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last?.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }

  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : null,
    contents,
  };
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
