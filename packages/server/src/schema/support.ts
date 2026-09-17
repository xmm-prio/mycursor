/**
 * What an extracted schema can actually be used for.
 *
 * Extraction is anchored by textual heuristics against minified bundles, so a
 * new Cursor release can change the codegen shape and leave the result
 * partial rather than empty. A partial schema is the dangerous outcome: the
 * command reports success, the file is written, and the features that needed
 * the missing types quietly fall back to forwarding — which presents as
 * "BYOK does not work" with nothing pointing at the cause.
 *
 * Naming the types each feature needs turns that into a diagnosis.
 */

import type { DescriptorRegistry } from '@mycursor/protocol/schema';

export interface SchemaFeature {
  /** What stops working without it, in the user's terms. */
  readonly label: string;
  readonly types: readonly string[];
}

export const SCHEMA_FEATURES: readonly SchemaFeature[] = [
  {
    label: 'models in the picker',
    types: [
      'aiserver.v1.AvailableModelsResponse',
      'aiserver.v1.AvailableModelsResponse.AvailableModel',
    ],
  },
  {
    label: 'native agent chat',
    types: [
      'agent.v1.AgentClientMessage',
      'agent.v1.AgentServerMessage',
      'aiserver.v1.BidiAppendRequest',
      'agent.v1.AgentRunRequest',
      'agent.v1.ConversationHistory',
      'agent.v1.InteractionUpdate',
      'agent.v1.ToolCall',
    ],
  },
  {
    label: 'MCP tool forwarding',
    types: ['agent.v1.McpToolDefinition', 'agent.v1.McpArgs', 'google.protobuf.Value'],
  },
  {
    label: 'knowledge base',
    types: [
      'aiserver.v1.KnowledgeBaseListRequest',
      'aiserver.v1.KnowledgeBaseListResponse',
      'aiserver.v1.KnowledgeBaseAddRequest',
    ],
  },
];

export interface FeatureSupport {
  label: string;
  supported: boolean;
  /** Types the feature needs that the schema does not have. */
  missing: string[];
}

export function describeSchemaSupport(registry: DescriptorRegistry): FeatureSupport[] {
  return SCHEMA_FEATURES.map((feature) => {
    const missing = feature.types.filter((type) => !registry.has(type));
    return { label: feature.label, supported: missing.length === 0, missing };
  });
}
