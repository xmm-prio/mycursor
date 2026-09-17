/**
 * Provider configuration and model resolution.
 *
 * The registry owns two questions: which providers exist, and which one serves
 * a given model id. Keeping that separate from the adapters means adding a
 * provider type is one file plus one line here, and adding a model is a
 * configuration edit with no code at all.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AnthropicProvider } from './adapters/anthropic.js';
import { GeminiProvider } from './adapters/gemini.js';
import { OpenAiProvider } from './adapters/openai.js';
import {
  createModel,
  normaliseProvider,
  PROVIDERS_SCHEMA_VERSION,
  DEFAULT_BASE_URLS,
} from './defaults.js';
import { kindOfType, type Provider, type ProviderConfig, type ProviderModel } from './types.js';

export interface ProvidersDocument {
  $schemaVersion: number;
  providers: ProviderConfig[];
}

const FACTORIES = {
  openai: (config: ProviderConfig): Provider => new OpenAiProvider(config),
  anthropic: (config: ProviderConfig): Provider => new AnthropicProvider(config),
  gemini: (config: ProviderConfig): Provider => new GeminiProvider(config),
} as const;

export interface ResolvedModel {
  provider: Provider;
  model: ProviderModel;
}

export class ProviderRegistry {
  private readonly providers: Provider[] = [];
  private readonly byModel = new Map<string, ResolvedModel>();

  private constructor(readonly warnings: string[]) {}

  /**
   * Builds a registry from a configuration document.
   *
   * A provider with no key, no enabled models, or a shape this version does
   * not recognise is skipped with a warning rather than failing the load: one
   * misconfigured entry should not take every other provider offline.
   */
  static fromDocument(document: unknown): ProviderRegistry {
    const warnings: string[] = [];
    const registry = new ProviderRegistry(warnings);

    const entries = (document as ProvidersDocument | null)?.providers;
    if (!Array.isArray(entries)) {
      warnings.push('providers document has no "providers" array; no models are available');
      return registry;
    }

    for (const [index, raw] of entries.entries()) {
      const config = normaliseProvider(raw, index);
      if (!config.enabled) continue;

      if (!config.authValue) {
        warnings.push(`provider "${config.name}" has no auth value and was skipped`);
        continue;
      }
      const usable = config.models.filter((model) => model.enabled);
      if (usable.length === 0) {
        warnings.push(`provider "${config.name}" has no enabled models and was skipped`);
        continue;
      }

      const provider = FACTORIES[kindOfType(config.type)]({ ...config, models: usable });
      registry.providers.push(provider);

      for (const model of usable) {
        if (registry.byModel.has(model.id)) {
          warnings.push(
            `model "${model.id}" is served by more than one provider; keeping "${registry.byModel.get(model.id)!.provider.id}"`,
          );
          continue;
        }
        registry.byModel.set(model.id, { provider, model });
      }
    }

    return registry;
  }

  static empty(): ProviderRegistry {
    return new ProviderRegistry([]);
  }

  resolve(modelId: string): ResolvedModel | undefined {
    return this.byModel.get(modelId);
  }

  /** Every model, in configuration order — which is picker order in Cursor. */
  allModels(): { providerId: string; model: ProviderModel }[] {
    return [...this.byModel.values()].map((entry) => ({
      providerId: entry.provider.id,
      model: entry.model,
    }));
  }

  list(): Provider[] {
    return [...this.providers];
  }

  get size(): number {
    return this.providers.length;
  }
}

/** Reads and normalises the document, returning every provider including disabled ones. */
export function readProvidersDocument(path: string): ProvidersDocument {
  if (!existsSync(path)) return { $schemaVersion: PROVIDERS_SCHEMA_VERSION, providers: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ProvidersDocument;
    const providers = Array.isArray(parsed.providers) ? parsed.providers : [];
    return {
      $schemaVersion: PROVIDERS_SCHEMA_VERSION,
      providers: providers.map((entry, index) => normaliseProvider(entry, index)),
    };
  } catch {
    return { $schemaVersion: PROVIDERS_SCHEMA_VERSION, providers: [] };
  }
}

export function loadProvidersFrom(path: string): ProviderRegistry {
  if (!existsSync(path)) return ProviderRegistry.empty();
  try {
    return ProviderRegistry.fromDocument(JSON.parse(readFileSync(path, 'utf-8')));
  } catch (error) {
    const registry = ProviderRegistry.empty();
    registry.warnings.push(`providers document is unreadable: ${(error as Error).message}`);
    return registry;
  }
}

/** A starting point written on first install. */
export function createExampleProviders(): ProvidersDocument {
  const model = createModel('gpt-4.1');
  model.displayName = 'GPT-4.1';
  model.contextTokenLimit = 1_047_576;
  model.maxOutputTokens = 32_768;
  model.capabilities.images = true;

  return {
    $schemaVersion: PROVIDERS_SCHEMA_VERSION,
    providers: [
      {
        id: 'example-openai',
        name: 'OpenAI',
        type: 'openai-chat',
        // Left empty so the adapter's default applies; the panel shows a hint.
        baseUrl: '',
        authValue: '',
        enabled: false,
        models: [model],
      },
    ],
  };
}

export function saveProvidersTo(path: string, document: ProvidersDocument): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.providers.${process.pid}.tmp`);
  writeFileSync(
    temp,
    `${JSON.stringify({ ...document, $schemaVersion: PROVIDERS_SCHEMA_VERSION }, null, 2)}\n`,
    'utf-8',
  );
  renameSync(temp, path);
}

export { DEFAULT_BASE_URLS };
