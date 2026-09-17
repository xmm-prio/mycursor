/**
 * Defaults and normalisation for provider documents.
 *
 * The configuration panel writes a rich document, but a hand-edited file — or
 * one written by an earlier version of this toolkit — may be missing almost
 * any field. Normalising in one place means the panel, the registry and the
 * model injection all see the same complete shape, and neither the UI nor the
 * server has to defend against half-filled entries.
 */

import {
  kindOfType,
  THINKING_LEVELS,
  type ModelCapabilities,
  type ProviderConfig,
  type ProviderModel,
  type ProviderType,
  type QuickSwitchOptions,
  type ThinkingLevel,
} from './types.js';

export const PROVIDERS_SCHEMA_VERSION = 2;

/** Base URLs used when a provider entry leaves the field empty. */
export const DEFAULT_BASE_URLS: Record<ProviderType, string> = {
  'openai-chat': 'https://api.openai.com/v1',
  'anthropic-messages': 'https://api.anthropic.com/v1',
  'gemini-generate': 'https://generativelanguage.googleapis.com/v1beta',
};

export const DEFAULT_CONTEXT_TOKEN_LIMIT = 128_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

export function defaultCapabilities(): ModelCapabilities {
  return {
    agent: true,
    images: false,
    cmdK: true,
    fast: false,
    thinking: false,
    thinkingLevel: 'medium',
  };
}

export function defaultQuickSwitch(): QuickSwitchOptions {
  return { reasoningLevels: [], contextOptions: [], fastToggle: false };
}

export function createModel(apiModel = ''): ProviderModel {
  return {
    id: apiModel,
    apiModel,
    displayName: apiModel,
    enabled: true,
    capabilities: defaultCapabilities(),
    contextTokenLimit: DEFAULT_CONTEXT_TOKEN_LIMIT,
    maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    quickSwitch: defaultQuickSwitch(),
  };
}

export function createProvider(type: ProviderType = 'openai-chat'): ProviderConfig {
  return {
    id: `provider-${Date.now().toString(36)}`,
    name: 'New provider',
    type,
    baseUrl: '',
    authValue: '',
    models: [],
    enabled: true,
  };
}

type Unknown = Record<string, unknown>;

const asObject = (value: unknown): Unknown =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Unknown) : {};

const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const asBoolean = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback;

function asPositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
    ? Math.trunc(parsed)
    : fallback;
}

function asThinkingLevel(value: unknown, fallback: ThinkingLevel): ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as string[]).includes(value)
    ? (value as ThinkingLevel)
    : fallback;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Accepts both the current document shape and the earlier one.
 *
 * The earlier shape used `kind`/`apiKey` and flat capability booleans; reading
 * it here rather than migrating the file means an upgrade never has to rewrite
 * a document that might hold the user's only copy of an API key.
 */
export function normaliseProviderType(value: unknown, legacyKind: unknown): ProviderType {
  if (value === 'openai-chat' || value === 'anthropic-messages' || value === 'gemini-generate') {
    return value;
  }
  if (legacyKind === 'anthropic') return 'anthropic-messages';
  if (legacyKind === 'gemini') return 'gemini-generate';
  return 'openai-chat';
}

export function normaliseModel(raw: unknown, index: number): ProviderModel | null {
  const source = asObject(raw);
  // `upstreamId` is the earlier field name for `apiModel`.
  const apiModel = asString(source['apiModel'], asString(source['upstreamId'], asString(source['id'])));
  if (!apiModel.trim()) return null;

  const id = asString(source['id'], apiModel).trim() || apiModel;
  const capabilitiesRaw = asObject(source['capabilities']);
  const quickSwitchRaw = asObject(source['quickSwitch']);
  const fallback = defaultCapabilities();

  const model: ProviderModel = {
    id,
    apiModel: apiModel.trim(),
    displayName: asString(source['displayName'], id).trim() || id,
    enabled: asBoolean(source['enabled'], true),
    capabilities: {
      agent: asBoolean(capabilitiesRaw['agent'], asBoolean(source['supportsTools'], fallback.agent)),
      images: asBoolean(capabilitiesRaw['images'], asBoolean(source['supportsImages'], fallback.images)),
      cmdK: asBoolean(capabilitiesRaw['cmdK'], fallback.cmdK),
      fast: asBoolean(capabilitiesRaw['fast'], fallback.fast),
      thinking: asBoolean(
        capabilitiesRaw['thinking'],
        asBoolean(source['supportsReasoning'], fallback.thinking),
      ),
      thinkingLevel: asThinkingLevel(capabilitiesRaw['thinkingLevel'], fallback.thinkingLevel),
    },
    contextTokenLimit: asPositiveInteger(
      source['contextTokenLimit'] ?? source['contextWindow'],
      DEFAULT_CONTEXT_TOKEN_LIMIT,
    ),
    maxOutputTokens: asPositiveInteger(source['maxOutputTokens'], DEFAULT_MAX_OUTPUT_TOKENS),
    quickSwitch: {
      reasoningLevels: asStringList(quickSwitchRaw['reasoningLevels']).filter((level) =>
        (THINKING_LEVELS as string[]).includes(level),
      ) as ThinkingLevel[],
      contextOptions: asStringList(quickSwitchRaw['contextOptions']),
      fastToggle: asBoolean(quickSwitchRaw['fastToggle'], false),
    },
  };

  const tooltip = asString(source['tooltipMarkdown']).trim();
  if (tooltip) model.tooltipMarkdown = tooltip;
  // Index only feeds the fallback id, so an unnamed model is still addressable.
  if (!model.id) model.id = `model-${index}`;
  return model;
}

export function normaliseProvider(raw: unknown, index: number): ProviderConfig {
  const source = asObject(raw);
  const type = normaliseProviderType(source['type'], source['kind']);
  const id = asString(source['id'], `provider-${index}`).trim() || `provider-${index}`;

  const models: ProviderModel[] = [];
  const rawModels = Array.isArray(source['models']) ? source['models'] : [];
  for (const [modelIndex, rawModel] of rawModels.entries()) {
    const model = normaliseModel(rawModel, modelIndex);
    if (model) models.push(model);
  }

  const headersRaw = asObject(source['headers']);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersRaw)) {
    if (typeof value === 'string') headers[key] = value;
  }

  const provider: ProviderConfig = {
    id,
    name: asString(source['name'], id).trim() || id,
    type,
    baseUrl: asString(source['baseUrl']).trim(),
    // `apiKey` is the earlier field name for `authValue`.
    authValue: asString(source['authValue'], asString(source['apiKey'])).trim(),
    models,
    enabled: asBoolean(source['enabled'], true),
  };

  const proxyUrl = asString(source['proxyUrl']).trim();
  if (proxyUrl) provider.proxyUrl = proxyUrl;
  if (Object.keys(headers).length > 0) provider.headers = headers;
  return provider;
}

/** Resolves the base URL a provider will actually dial. */
export function effectiveBaseUrl(provider: ProviderConfig): string {
  return (provider.baseUrl || DEFAULT_BASE_URLS[provider.type]).replace(/\/+$/, '');
}

export function effectiveKind(provider: ProviderConfig): ReturnType<typeof kindOfType> {
  return kindOfType(provider.type);
}
