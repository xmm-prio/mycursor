/**
 * Running one agent turn against a provider.
 *
 * The runner is deliberately transport-agnostic: it takes a turn, yields
 * normalised events, and knows nothing about ConnectRPC, protobuf, or which
 * ingress produced the turn. That seam is what lets the same loop serve the
 * OpenAI-compatible endpoint this server exposes and Cursor's own agent
 * endpoint, and it is what makes the loop testable without a Cursor install.
 */

import type { ToolPolicyConfig } from '@mycursor/core/config';
import type { Logger } from '@mycursor/core/logging';
import type { ToolDescriptor } from '@mycursor/core/tools';
import type {
  ChatEvent,
  ChatMessage,
  ProviderRegistry,
  ToolCall,
} from '@mycursor/providers';

import { assembleTools, type ServerToolProvider } from './tool-assembly.js';

/**
 * How many rounds of server tool calls one turn may make.
 *
 * A model that keeps searching would otherwise spend the user's tokens in a
 * loop they cannot see or stop, since none of it reaches the IDE until the
 * turn ends.
 */
const MAX_SERVER_TOOL_ROUNDS = 6;

export interface AgentTurn {
  /** Model id as Cursor knows it. */
  model: string;
  messages: ChatMessage[];
  /** Tools the client declared. Preserved verbatim; see `tool-assembly`. */
  nativeTools: ToolDescriptor[];
  temperature?: number;
  maxOutputTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
}

export type TurnEvent =
  | ChatEvent
  /** Emitted once, before the first provider event, for diagnostics. */
  | {
      type: 'turn-start';
      providerId: string;
      model: string;
      tools: { native: number; added: number; shadowed: number };
    }
  /**
   * A server tool the runner ran itself.
   *
   * Surfaced so the caller can show the user that a search happened; the
   * call never reaches the client, which has no way to execute it.
   */
  | { type: 'server-tool'; name: string; argumentsJson: string; resultPreview: string };

export interface TurnRunnerDeps {
  providers: () => ProviderRegistry;
  toolPolicy: () => ToolPolicyConfig;
  serverTools?: () => readonly ServerToolProvider[];
  logger: Logger;
}

export class UnknownModelError extends Error {
  constructor(readonly model: string, readonly available: string[]) {
    super(
      available.length === 0
        ? `no models are configured; add a provider to providers.json (requested "${model}")`
        : `model "${model}" is not configured. Available: ${available.slice(0, 12).join(', ')}`,
    );
    this.name = 'UnknownModelError';
  }
}

export class TurnRunner {
  constructor(private readonly deps: TurnRunnerDeps) {}

  /**
   * Streams a turn.
   *
   * A provider failure before the first token is thrown, so the caller can map
   * it onto a protocol-level error. Once output has started, a failure is
   * reported as an event instead: the client has already rendered text, and a
   * late protocol error would discard it.
   */
  async *run(turn: AgentTurn, signal?: AbortSignal): AsyncGenerator<TurnEvent, void, undefined> {
    const registry = this.deps.providers();
    const resolved = registry.resolve(turn.model);
    if (!resolved) {
      throw new UnknownModelError(
        turn.model,
        registry.allModels().map((entry) => entry.model.id),
      );
    }

    const assembly = assembleTools({
      nativeTools: turn.nativeTools,
      policy: this.deps.toolPolicy(),
      serverProviders: this.deps.serverTools?.() ?? [],
      logger: this.deps.logger,
    });

    yield {
      type: 'turn-start',
      providerId: resolved.provider.id,
      model: turn.model,
      tools: {
        native: assembly.report.native.length,
        added: assembly.report.added.length,
        shadowed: assembly.report.shadowed.length,
      },
    };

    // Server tools are invisible to the client, so a call to one has to be
    // resolved here. The conversation is extended locally and the provider is
    // asked again, until it stops asking for them.
    const messages = [...turn.messages];
    let emitted = false;
    let round = 0;

    try {
      for (;;) {
        const pending: ToolCall[] = [];
        let handedOff = false;

        for await (const event of resolved.provider.streamChat({
          model: turn.model,
          messages,
          tools: assembly.tools,
          ...(turn.temperature !== undefined ? { temperature: turn.temperature } : {}),
          ...(turn.maxOutputTokens ? { maxOutputTokens: turn.maxOutputTokens } : {}),
          ...(turn.reasoningEffort ? { reasoningEffort: turn.reasoningEffort } : {}),
          ...(signal ? { signal } : {}),
        })) {
          if (event.type === 'tool-call' && assembly.executors.has(event.call.name)) {
            pending.push(event.call);
            continue;
          }
          // A call the client owns ends the loop: the IDE runs it and comes
          // back with a fresh request carrying the result.
          if (event.type === 'tool-call') handedOff = true;
          // `done` is withheld while server calls are pending, so the caller
          // does not close the turn before the follow-up arrives.
          if (event.type === 'done' && pending.length > 0 && !handedOff) continue;
          emitted = true;
          yield event;
        }

        if (pending.length === 0) return;

        if (handedOff) {
          // The model asked for a client tool and a server tool at once. The
          // client call has already been forwarded and will end the turn, so
          // the server call cannot be answered — saying so is better than
          // running it and throwing the result away.
          for (const call of pending) {
            this.deps.logger.warn('a server tool call was dropped alongside a client tool call', {
              tool: call.name,
            });
          }
          return;
        }

        round += 1;
        if (round > MAX_SERVER_TOOL_ROUNDS) {
          this.deps.logger.warn('server tool loop hit its limit', { rounds: round });
          yield {
            type: 'text',
            delta: `\n_(stopped after ${MAX_SERVER_TOOL_ROUNDS} web tool calls in one turn)_\n`,
          };
          yield { type: 'done', reason: 'stop' };
          return;
        }

        messages.push({ role: 'assistant', content: [], toolCalls: pending });
        for (const call of pending) {
          const result = await this.runServerTool(assembly, call, signal);
          emitted = true;
          yield {
            type: 'server-tool',
            name: call.name,
            argumentsJson: call.argumentsJson,
            resultPreview: result.slice(0, 200),
          };
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: [{ type: 'text', text: result }],
          });
        }
      }
    } catch (error) {
      if (!emitted) throw error;
      this.deps.logger.warn('provider stream failed after output had started', {
        provider: resolved.provider.id,
        model: turn.model,
        error: (error as Error).message,
      });
      yield { type: 'error', message: (error as Error).message, retryable: true };
      yield { type: 'done', reason: 'error' };
    }
  }

  private async runServerTool(
    assembly: { executors: Map<string, ServerToolProvider> },
    call: ToolCall,
    signal?: AbortSignal,
  ): Promise<string> {
    const provider = assembly.executors.get(call.name);
    if (!provider) return `Tool "${call.name}" is not available.`;

    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(call.argumentsJson || '{}');
      if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
    } catch (error) {
      return `The arguments for "${call.name}" were not valid JSON: ${(error as Error).message}`;
    }

    try {
      return await provider.execute(call.name, args, signal);
    } catch (error) {
      // A provider that throws despite the contract must not abort the turn.
      this.deps.logger.error('a server tool threw', {
        tool: call.name,
        provider: provider.id,
        error: (error as Error).message,
      });
      return `Tool "${call.name}" failed: ${(error as Error).message}`;
    }
  }
}
