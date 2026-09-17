/**
 * An OpenAI-compatible façade over the provider registry.
 *
 * Cursor's agent endpoint speaks a private protobuf schema, so there is a
 * limit to how completely a third party can answer it. This endpoint has no
 * such limit, and it makes the whole provider and tool-preservation layer
 * usable and testable today:
 *
 *  - Cursor's own "custom OpenAI base URL" setting can point straight at it,
 *    which is a supported integration path that needs no schema knowledge;
 *  - any other OpenAI-compatible client works against it unchanged;
 *  - the tool set it sends upstream is assembled by the same native-first
 *    registry the agent path uses, so the preservation guarantee is exercised
 *    by ordinary requests rather than only by the parts that need reverse
 *    engineering.
 */

import type { Logger } from '@mycursor/core/logging';
import type { ToolDescriptor } from '@mycursor/core/tools';
import type { ChatMessage, ContentPart, ProviderRegistry, ToolCall } from '@mycursor/providers';

import type { Exchange, StreamWriter } from '../listener/exchange.js';
import { TurnRunner, UnknownModelError, type AgentTurn } from '../agent/turn.js';

export const OPENAI_PREFIX = '/v1/';

interface IncomingMessage {
  role?: string;
  content?: unknown;
  tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
}

interface IncomingRequest {
  model?: string;
  messages?: IncomingMessage[];
  tools?: { function?: { name?: string; description?: string; parameters?: unknown } }[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  reasoning_effort?: 'low' | 'medium' | 'high';
}

export interface OpenAiRoutesDeps {
  providers: () => ProviderRegistry;
  runner: TurnRunner;
  logger: Logger;
}

export class OpenAiRoutes {
  constructor(private readonly deps: OpenAiRoutesDeps) {}

  claims(path: string): boolean {
    return path.startsWith(OPENAI_PREFIX);
  }

  async handle(exchange: Exchange): Promise<void> {
    const path = exchange.path.split('?')[0] ?? exchange.path;

    if (path === '/v1/models') {
      this.listModels(exchange);
      return;
    }
    if (path === '/v1/chat/completions') {
      await this.chatCompletions(exchange);
      return;
    }
    exchange.sendJson(404, { error: { message: `mycursor: unsupported endpoint ${path}` } });
  }

  private listModels(exchange: Exchange): void {
    const models = this.deps.providers().allModels();
    exchange.sendJson(200, {
      object: 'list',
      data: models.map((entry) => ({
        id: entry.model.id,
        object: 'model',
        owned_by: entry.providerId,
        // Non-standard but harmless, and it is what a picker actually needs.
        context_window: entry.model.contextTokenLimit,
        max_output_tokens: entry.model.maxOutputTokens,
      })),
    });
  }

  private async chatCompletions(exchange: Exchange): Promise<void> {
    let body: IncomingRequest;
    try {
      body = JSON.parse(new TextDecoder().decode(await exchange.body())) as IncomingRequest;
    } catch (error) {
      exchange.sendJson(400, {
        error: { message: `mycursor: request body is not JSON: ${(error as Error).message}` },
      });
      return;
    }

    if (!body.model) {
      exchange.sendJson(400, { error: { message: 'mycursor: "model" is required' } });
      return;
    }

    const turn: AgentTurn = {
      model: body.model,
      messages: (body.messages ?? []).map(toChatMessage),
      // Tools declared by the caller are this endpoint's "native" set, and get
      // the same preservation guarantee as Cursor's own.
      nativeTools: (body.tools ?? []).map(toToolDescriptor).filter((tool) => tool.name),
      ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
      ...(body.max_tokens ? { maxOutputTokens: body.max_tokens } : {}),
      ...(body.reasoning_effort ? { reasoningEffort: body.reasoning_effort } : {}),
    };

    if (body.stream === false) {
      await this.respondBuffered(exchange, turn);
      return;
    }
    await this.respondStreaming(exchange, turn);
  }

  private async respondBuffered(exchange: Exchange, turn: AgentTurn): Promise<void> {
    const text: string[] = [];
    const toolCalls: ToolCall[] = [];
    let usage = { inputTokens: 0, outputTokens: 0 };
    let reason = 'stop';

    try {
      for await (const event of this.deps.runner.run(turn)) {
        if (event.type === 'text') text.push(event.delta);
        else if (event.type === 'tool-call') toolCalls.push(event.call);
        else if (event.type === 'usage') usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
        else if (event.type === 'done') reason = event.reason;
        else if (event.type === 'error') {
          exchange.sendJson(502, { error: { message: event.message } });
          return;
        }
      }
    } catch (error) {
      this.sendRunError(exchange, error);
      return;
    }

    exchange.sendJson(200, {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: turn.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: text.join('') || null,
            ...(toolCalls.length > 0
              ? {
                  tool_calls: toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.argumentsJson },
                  })),
                }
              : {}),
          },
          finish_reason: reason === 'tool-calls' ? 'tool_calls' : reason,
        },
      ],
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
    });
  }

  private async respondStreaming(exchange: Exchange, turn: AgentTurn): Promise<void> {
    const id = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);

    let writer: StreamWriter | null = null;
    const open = (): StreamWriter => {
      writer ??= exchange.beginStream(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      });
      return writer;
    };

    const emit = (delta: unknown, finishReason: string | null = null): void => {
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: turn.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      open().write(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    };

    try {
      let toolIndex = 0;
      for await (const event of this.deps.runner.run(turn)) {
        switch (event.type) {
          case 'turn-start':
            this.deps.logger.debug('turn started', {
              provider: event.providerId,
              model: event.model,
              nativeTools: event.tools.native,
              addedTools: event.tools.added,
            });
            break;
          case 'text':
            emit({ content: event.delta });
            break;
          case 'reasoning':
            // Non-standard, but the field several OpenAI-compatible services
            // agreed on, so a client that understands it gets the reasoning.
            emit({ reasoning_content: event.delta });
            break;
          case 'tool-call':
            emit({
              tool_calls: [
                {
                  index: toolIndex++,
                  id: event.call.id,
                  type: 'function',
                  function: { name: event.call.name, arguments: event.call.argumentsJson },
                },
              ],
            });
            break;
          case 'error':
            emit({}, 'error');
            break;
          case 'done':
            emit({}, event.reason === 'tool-calls' ? 'tool_calls' : event.reason);
            break;
          default:
            break;
        }
      }
    } catch (error) {
      // Nothing has been written yet if `run` threw before its first event, so
      // a proper HTTP error is still possible.
      if (!writer) {
        this.sendRunError(exchange, error);
        return;
      }
      emit({}, 'error');
    }

    open().write(new TextEncoder().encode('data: [DONE]\n\n'));
    open().end();
  }

  private sendRunError(exchange: Exchange, error: unknown): void {
    if (error instanceof UnknownModelError) {
      exchange.sendJson(404, { error: { message: error.message, type: 'model_not_found' } });
      return;
    }
    exchange.sendJson(502, { error: { message: `mycursor: ${(error as Error).message}` } });
  }
}

function toToolDescriptor(tool: {
  function?: { name?: string; description?: string; parameters?: unknown };
}): ToolDescriptor {
  return {
    name: tool.function?.name ?? '',
    ...(tool.function?.description ? { description: tool.function.description } : {}),
    ...(tool.function?.parameters !== undefined ? { parameters: tool.function.parameters } : {}),
    origin: 'native',
    raw: tool,
  };
}

function toChatMessage(message: IncomingMessage): ChatMessage {
  const role =
    message.role === 'system' || message.role === 'assistant' || message.role === 'tool'
      ? message.role
      : 'user';

  return {
    role,
    content: toContentParts(message.content),
    ...(message.tool_calls?.length
      ? {
          toolCalls: message.tool_calls.map((call, index) => ({
            id: call.id ?? `call_${index}`,
            name: call.function?.name ?? '',
            argumentsJson: call.function?.arguments ?? '{}',
          })),
        }
      : {}),
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
  };
}

function toContentParts(content: unknown): ContentPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];

  const parts: ContentPart[] = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const part = item as { type?: string; text?: string; image_url?: { url?: string } };
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'text', text: part.text });
      continue;
    }
    const url = part.image_url?.url;
    if (part.type === 'image_url' && typeof url === 'string') {
      const match = url.match(/^data:([^;]+);base64,(.*)$/);
      if (match) parts.push({ type: 'image', mediaType: match[1]!, dataBase64: match[2]! });
    }
  }
  return parts;
}
