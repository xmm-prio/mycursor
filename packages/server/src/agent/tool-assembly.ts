/**
 * Assembling the tool set for a turn.
 *
 * This is where the promise that Cursor's own tools survive BYOK routing is
 * actually kept. Once the toolkit answers the agent endpoint, it decides what
 * tool list the upstream model sees — and if it substituted its own list, the
 * IDE's file edits, terminal and search would stop working while the chat
 * still appeared healthy. That failure is silent, which is why the rule is
 * encoded as an invariant in `ToolRegistry` rather than left to each handler.
 *
 * Server-side tools are strictly additive. They fill gaps in a thin client and
 * step aside the moment the client ships an equivalent of its own.
 */

import type { ToolPolicyConfig } from '@mycursor/core/config';
import { ToolRegistry, type ToolDescriptor } from '@mycursor/core/tools';
import type { Logger } from '@mycursor/core/logging';

/**
 * Tools the server can contribute when the client has no equivalent.
 *
 * A server tool is also *run* by the server: the Cursor client has never
 * heard of it, so a call must be executed here and its result fed back to
 * the model within the same turn. That is why the interface carries
 * `execute` rather than only a declaration.
 */
export interface ServerToolProvider {
  readonly id: string;
  tools(): ToolDescriptor[];
  execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string>;
}

export interface AssemblyResult {
  registry: ToolRegistry;
  tools: ToolDescriptor[];
  report: {
    native: string[];
    added: string[];
    shadowed: string[];
    denied: string[];
  };
  /** Server tools that survived assembly, keyed by the name the model sees. */
  executors: Map<string, ServerToolProvider>;
}

/**
 * Builds the tool list for one turn.
 *
 * `nativeTools` comes from the client's run request and is treated as
 * authoritative: entries are forwarded with their descriptions and schemas
 * untouched, in declaration order, so upstream prompt caching stays effective.
 */
export function assembleTools(input: {
  nativeTools: readonly ToolDescriptor[];
  policy: ToolPolicyConfig;
  serverProviders?: readonly ServerToolProvider[];
  logger?: Logger;
}): AssemblyResult {
  const registry = ToolRegistry.fromNative(input.nativeTools, input.policy);
  const nativeNames = registry.snapshot().names;

  const augmentation: ToolDescriptor[] = [];
  for (const provider of input.serverProviders ?? []) {
    augmentation.push(...provider.tools());
  }
  const report = registry.augment(augmentation);

  const tools = registry.list();
  input.logger?.debug('tool set assembled', {
    native: nativeNames.length,
    added: report.added.length,
    shadowed: report.shadowed.length,
    denied: report.denied.length,
    total: tools.length,
  });

  if (input.policy.preserveNative && input.nativeTools.length > 0 && nativeNames.length === 0) {
    // Reaching here would mean the client declared tools and none survived,
    // which is precisely the silent failure this module exists to prevent.
    input.logger?.error('client declared tools but none were preserved', {
      declared: input.nativeTools.length,
    });
  }

  return {
    registry,
    tools,
    report: {
      native: nativeNames,
      added: report.added,
      shadowed: report.shadowed,
      denied: report.denied,
    },
    executors: buildExecutors(input.serverProviders ?? [], report.added),
  };
}

/**
 * Maps the tool names that survived assembly onto the provider that runs them.
 *
 * Only names in `added` are included: a server tool shadowed by a client tool
 * of the same name belongs to the client, and running it here would hijack a
 * call the IDE was meant to handle.
 */
function buildExecutors(
  providers: readonly ServerToolProvider[],
  added: readonly string[],
): Map<string, ServerToolProvider> {
  const live = new Set(added);
  const executors = new Map<string, ServerToolProvider>();
  for (const provider of providers) {
    for (const tool of provider.tools()) {
      if (live.has(tool.name) && !executors.has(tool.name)) executors.set(tool.name, provider);
    }
  }
  return executors;
}
