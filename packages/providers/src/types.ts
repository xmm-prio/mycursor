/**
 * The provider contract.
 *
 * One shape in, one event stream out. Everything provider-specific — how a
 * tool schema is spelled, whether reasoning arrives as a separate field, which
 * header carries the key — is absorbed by the adapter, so the agent loop above
 * never branches on which model it is talking to.
 *
 * The event stream is deliberately flat and additive rather than a nested
 * response object: Cursor consumes model output incrementally, and a flat
 * stream maps onto that without buffering a whole turn first.
 */

import type { ToolDescriptor } from '@mycursor/core/tools';

/**
 * Wire protocol a provider speaks.
 *
 * Named after the endpoint rather than the vendor, because the same protocol
 * serves many services: `openai-chat` covers OpenAI, DeepSeek, OpenRouter,
 * Groq, Together and any local server that copied the schema.
 */
export type ProviderType = 'openai-chat' | 'anthropic-messages' | 'gemini-generate';

/** Family a `ProviderType` belongs to, which selects the adapter. */
export type ProviderKind = 'openai' | 'anthropic' | 'gemini';

export const PROVIDER_TYPES: { type: ProviderType; kind: ProviderKind; label: string }[] = [
  { type: 'openai-chat', kind: 'openai', label: 'OpenAI Chat Completions' },
  { type: 'anthropic-messages', kind: 'anthropic', label: 'Anthropic Messages' },
  { type: 'gemini-generate', kind: 'gemini', label: 'Google Gemini' },
];

export function kindOfType(type: ProviderType): ProviderKind {
  return PROVIDER_TYPES.find((entry) => entry.type === type)?.kind ?? 'openai';
}

/** Reasoning effort levels offered in the picker and sent upstream. */
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'max';

export const THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'max'];

/**
 * What a model can do, as shown by the toggles in the configuration panel.
 *
 * These map onto the fields Cursor's model picker actually reads, so a toggle
 * here changes what the IDE lets the model be used for.
 */
export interface ModelCapabilities {
  /** Selectable for agent work rather than chat only. */
  agent: boolean;
  images: boolean;
  /** Available in the inline Cmd+K editor. */
  cmdK: boolean;
  /** Offered as a quick, cheaper variant. */
  fast: boolean;
  thinking: boolean;
  thinkingLevel: ThinkingLevel;
}

/**
 * Options Cursor offers behind the model's quick-switch control.
 *
 * Emitted as `ModelParameterDefinition` entries, which is how Cursor renders
 * per-model switches in the picker.
 */
export interface QuickSwitchOptions {
  /** Reasoning levels the user can cycle between, e.g. `low`, `high`. */
  reasoningLevels: ThinkingLevel[];
  /** Context sizes the user can choose, as display labels. */
  contextOptions: string[];
  /** Whether a fast/slow switch is offered. */
  fastToggle: boolean;
}

export interface ProviderModel {
  /** Identity in Cursor's picker; defaults to the API model name. */
  id: string;
  /** Model name sent upstream. */
  apiModel: string;
  displayName: string;
  /** Excluded from injection when false — the panel's "Off" switch. */
  enabled: boolean;
  capabilities: ModelCapabilities;
  /** Required: Cursor refuses to render a model without a context limit. */
  contextTokenLimit: number;
  /** Required: caps the response and is sent upstream. */
  maxOutputTokens: number;
  /** Markdown shown when hovering the model in the picker. */
  tooltipMarkdown?: string;
  quickSwitch: QuickSwitchOptions;
}

/** A configured upstream, as it appears in `providers.json`. */
export interface ProviderConfig {
  id: string;
  /** Human-readable name shown in the configuration panel. */
  name: string;
  type: ProviderType;
  /** API base URL; empty means the adapter's default for this type. */
  baseUrl: string;
  /** API key, token, or whatever the service's auth header carries. */
  authValue: string;
  /** HTTP(S) proxy to reach the service through. */
  proxyUrl?: string;
  /** Extra headers, for gateways and beta flags such as `anthropic-beta`. */
  headers?: Record<string, string>;
  models: ProviderModel[];
  enabled: boolean;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; dataBase64: string };

export interface ToolCall {
  id: string;
  name: string;
  /** Arguments as a JSON string, which is what every provider actually sends. */
  argumentsJson: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentPart[];
  /** Assistant turns that requested tools. */
  toolCalls?: ToolCall[];
  /** Tool results: the call this message answers. */
  toolCallId?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /**
   * The assembled tool set, native tools first.
   *
   * Built by `ToolRegistry`, which guarantees Cursor's own tools are present
   * and unmodified. An adapter converts but never filters this list.
   */
  tools: ToolDescriptor[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Reasoning effort, for models that expose it. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  /** A tool call, complete. Adapters accumulate partial arguments internally. */
  | { type: 'tool-call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  /**
   * A failure that happened after output had already started.
   *
   * Distinct from a thrown `ProviderError`: once text has been delivered the
   * caller cannot turn the failure into a protocol error without discarding
   * what the user already sees, so it travels as an event instead.
   */
  | { type: 'error'; message: string; retryable: boolean }
  | { type: 'done'; reason: 'stop' | 'length' | 'tool-calls' | 'aborted' | 'error' };

export interface Provider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly models: ProviderModel[];
  /** Streams a turn. Adapters must not throw after the first event. */
  streamChat(request: ChatRequest): AsyncIterable<ChatEvent>;
  /** Asks the service which models it serves, for the panel's Fetch button. */
  listModels(signal?: AbortSignal): Promise<CatalogEntry[]>;
}

/** A model the upstream service reports, used to populate the panel. */
export interface CatalogEntry {
  id: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

/** Raised for a failure that happened before any event was emitted. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
