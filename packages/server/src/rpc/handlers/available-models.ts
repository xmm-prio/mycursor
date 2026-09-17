/**
 * `aiserver.v1.AiService/AvailableModels`
 *
 * This is the endpoint that puts a model in Cursor's picker, and therefore the
 * one that makes bring-your-own-key visible in the IDE rather than only
 * reachable through a custom base URL.
 *
 * The response is assembled from the configured providers using the schema
 * recovered from the installed Cursor, so the field numbers are the ones this
 * Cursor build actually expects. Without descriptors the request is forwarded
 * instead: answering with guessed field numbers would produce a reply the
 * client misparses, which presents as an empty or broken model list and is
 * much harder to diagnose than a forwarded request.
 *
 * Cursor's own models are preserved. The upstream response is fetched first
 * and the local models are *appended* to it, so switching BYOK on does not
 * take away the models the user already had. When upstream cannot be reached —
 * no account, offline — the local models stand alone.
 */

import type { Logger } from '@mycursor/core/logging';
import type { ProviderModel, ProviderRegistry } from '@mycursor/providers';
import {
  decodeMessage,
  encodeMessage,
  type DescriptorRegistry,
  type MessageValue,
} from '@mycursor/protocol/schema';

const RESPONSE_TYPE = 'aiserver.v1.AvailableModelsResponse';
const MODEL_TYPE = 'aiserver.v1.AvailableModelsResponse.AvailableModel';

export interface AvailableModelsInput {
  descriptors: DescriptorRegistry;
  providers: ProviderRegistry;
  /** Response bytes from the official API, when they could be fetched. */
  upstreamResponse: Uint8Array | null;
  logger: Logger;
}

export interface AvailableModelsOutcome {
  /** Encoded response, or null when the request should be forwarded instead. */
  bytes: Uint8Array | null;
  reason: string;
  localModels: number;
  upstreamModels: number;
}

/**
 * Builds the response.
 *
 * Returns `bytes: null` when it cannot be built correctly, which the caller
 * turns into a forward.
 */
export function buildAvailableModelsResponse(input: AvailableModelsInput): AvailableModelsOutcome {
  const { descriptors, providers, upstreamResponse, logger } = input;

  if (!descriptors.has(RESPONSE_TYPE) || !descriptors.has(MODEL_TYPE)) {
    return {
      bytes: null,
      reason: 'no descriptor for AvailableModelsResponse; run "mycursor schema"',
      localModels: 0,
      upstreamModels: 0,
    };
  }

  const local = providers.allModels();
  if (local.length === 0) {
    return {
      bytes: null,
      reason: 'no local models are configured',
      localModels: 0,
      upstreamModels: 0,
    };
  }

  // Start from the upstream response so Cursor's own models, feature model
  // configuration and display settings survive.
  let response: MessageValue = {};
  let upstreamModels = 0;
  if (upstreamResponse && upstreamResponse.length > 0) {
    try {
      response = decodeMessage(descriptors, RESPONSE_TYPE, upstreamResponse);
      upstreamModels = Array.isArray(response['models']) ? response['models'].length : 0;
    } catch (error) {
      logger.warn('upstream model list could not be decoded; serving local models only', {
        error: (error as Error).message,
      });
      response = {};
    }
  }

  const models = Array.isArray(response['models']) ? [...(response['models'] as MessageValue[])] : [];
  const names = Array.isArray(response['modelNames']) ? [...(response['modelNames'] as string[])] : [];
  const taken = new Set(models.map((model) => String(model['name'] ?? '')));

  let added = 0;
  for (const entry of local) {
    if (taken.has(entry.model.id)) {
      // An upstream model of the same name already exists; leaving it alone
      // keeps the picker consistent with what the user sees signed in.
      logger.debug('local model shadowed by an upstream model of the same name', {
        model: entry.model.id,
      });
      continue;
    }
    models.push(toAvailableModel(entry.providerId, entry.model));
    names.push(entry.model.id);
    taken.add(entry.model.id);
    added += 1;
  }

  response['models'] = models;
  response['modelNames'] = names;

  try {
    return {
      bytes: encodeMessage(descriptors, RESPONSE_TYPE, response),
      reason: upstreamModels > 0 ? 'local models appended to the upstream list' : 'local models only',
      localModels: added,
      upstreamModels,
    };
  } catch (error) {
    return {
      bytes: null,
      reason: `response could not be encoded: ${(error as Error).message}`,
      localModels: added,
      upstreamModels,
    };
  }
}

/**
 * Maps a configured model onto Cursor's `AvailableModel`.
 *
 * The capability switches in the configuration panel map one-to-one onto the
 * fields Cursor's picker reads, so turning "Agent" off here is what actually
 * removes the model from agent selection rather than merely relabelling it.
 *
 * Only fields the descriptor declares are set; the codec ignores unknown keys,
 * so a field a future Cursor renames is dropped rather than mis-encoded.
 */
function toAvailableModel(providerId: string, model: ProviderModel): MessageValue {
  const { capabilities, quickSwitch } = model;
  const value: MessageValue = {
    name: model.id,
    defaultOn: false,
    supportsAgent: capabilities.agent,
    // Without agent support the model is chat-only, which is a separate flag
    // the picker uses to decide where it may be offered.
    isChatOnly: !capabilities.agent,
    supportsCmdK: capabilities.cmdK,
    supportsImages: capabilities.images,
    supportsThinking: capabilities.thinking,
    supportsNonMaxMode: true,
    supportsAutoContext: true,
    autoContextMaxTokens: model.contextTokenLimit,
    contextTokenLimit: model.contextTokenLimit,
    contextTokenLimitForMaxMode: model.contextTokenLimit,
    clientDisplayName: model.displayName,
    inputboxShortModelName: model.displayName,
    serverModelName: model.apiModel,
    // Surfaced in the picker so a BYOK model is distinguishable from a Cursor
    // one at a glance.
    isUserAdded: true,
    vendorName: providerId,
    tooltipData: {
      primaryText: model.displayName,
      secondaryText: `mycursor · ${providerId}`,
      ...(model.tooltipMarkdown ? { markdownContent: model.tooltipMarkdown } : {}),
    },
  };

  const parameters = buildParameterDefinitions(capabilities, quickSwitch);
  if (parameters.length > 0) value['parameterDefinitions'] = parameters;
  return value;
}

/**
 * Builds the quick-switch controls Cursor renders next to the model.
 *
 * Each becomes a `ModelParameterDefinition`, which is the mechanism the picker
 * uses for per-model switches such as reasoning effort.
 */
function buildParameterDefinitions(
  capabilities: ProviderModel['capabilities'],
  quickSwitch: ProviderModel['quickSwitch'],
): MessageValue[] {
  const definitions: MessageValue[] = [];

  if (capabilities.thinking && quickSwitch.reasoningLevels.length > 0) {
    definitions.push({
      id: 'reasoning_effort',
      name: 'Reasoning',
      parameterType: {
        enumParameter: {
          values: quickSwitch.reasoningLevels.map((level) => ({
            value: level,
            displayName: capitalise(level),
            // Higher effort costs more; flagging it lets the picker warn.
            increasesModelCost: level === 'high' || level === 'max',
          })),
        },
      },
      isCycleableByHotkey: true,
    });
  }

  if (quickSwitch.contextOptions.length > 0) {
    definitions.push({
      id: 'context_size',
      name: 'Context',
      parameterType: {
        enumParameter: {
          values: quickSwitch.contextOptions.map((option) => ({
            value: option,
            displayName: option,
          })),
        },
      },
      isCycleableByHotkey: false,
    });
  }

  if (quickSwitch.fastToggle) {
    definitions.push({
      id: 'fast',
      name: 'Fast',
      parameterType: {
        booleanParameter: {
          values: [
            { value: 'false', displayName: 'Standard' },
            { value: 'true', displayName: 'Fast' },
          ],
        },
      },
      isCycleableByHotkey: true,
    });
  }

  return definitions;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export { RESPONSE_TYPE as AVAILABLE_MODELS_RESPONSE_TYPE, MODEL_TYPE as AVAILABLE_MODEL_TYPE };
