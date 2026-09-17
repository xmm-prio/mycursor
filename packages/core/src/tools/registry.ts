/**
 * Tool set assembly with native precedence.
 *
 * When BYOK routing takes over the agent endpoint, the toolkit becomes
 * responsible for the tool list handed to the upstream model. Cursor's own
 * tools — file edits, terminal, search, and everything else the client
 * declares — arrive inside the run request and must reach the model unchanged,
 * otherwise the IDE's native capabilities quietly disappear.
 *
 * The registry encodes that as an invariant rather than a convention: native
 * descriptors are stored verbatim and can never be replaced, renamed, or
 * dropped by augmentation.
 */

import type { ToolPolicyConfig } from '../config/types.js';

export type ToolOrigin = 'native' | 'augmented';

export interface ToolDescriptor {
  /** Tool name as the model will see it. */
  name: string;
  description?: string;
  /** JSON Schema for the tool arguments. */
  parameters?: unknown;
  origin: ToolOrigin;
  /**
   * The client-declared payload, kept untouched so it can be forwarded without
   * a lossy round trip through this toolkit's own representation.
   */
  raw?: unknown;
}

export interface AugmentationReport {
  added: string[];
  /** Names skipped because a native tool already owns them. */
  shadowed: string[];
  /** Names skipped because policy forbids them. */
  denied: string[];
}

export interface ToolRegistrySnapshot {
  native: number;
  augmented: number;
  names: string[];
}

export class ToolRegistry {
  private readonly nativeOrder: string[] = [];
  private readonly augmentedOrder: string[] = [];
  private readonly byName = new Map<string, ToolDescriptor>();

  private constructor(private readonly policy: ToolPolicyConfig) {}

  /**
   * Seeds the registry with the tools the Cursor client declared.
   *
   * Duplicated names inside the native set keep their first occurrence, which
   * matches how tool-calling APIs resolve collisions.
   */
  static fromNative(
    tools: readonly ToolDescriptor[],
    policy: ToolPolicyConfig,
  ): ToolRegistry {
    const registry = new ToolRegistry(policy);
    if (!policy.preserveNative) return registry;
    for (const tool of tools) {
      if (!tool?.name || registry.byName.has(tool.name)) continue;
      registry.byName.set(tool.name, { ...tool, origin: 'native' });
      registry.nativeOrder.push(tool.name);
    }
    return registry;
  }

  /**
   * Adds server-side tools that do not collide with a native name.
   *
   * Returns a report instead of throwing: a shadowed augmentation is a normal,
   * expected outcome once the client ships an equivalent native tool.
   */
  augment(tools: readonly ToolDescriptor[]): AugmentationReport {
    const report: AugmentationReport = { added: [], shadowed: [], denied: [] };
    if (!this.policy.allowAugmentation) {
      report.denied.push(...tools.map((tool) => tool.name).filter(Boolean));
      return report;
    }
    const denied = new Set(this.policy.augmentationDenyList);
    for (const tool of tools) {
      if (!tool?.name) continue;
      if (denied.has(tool.name)) {
        report.denied.push(tool.name);
        continue;
      }
      if (this.byName.has(tool.name)) {
        report.shadowed.push(tool.name);
        continue;
      }
      this.byName.set(tool.name, { ...tool, origin: 'augmented' });
      this.augmentedOrder.push(tool.name);
      report.added.push(tool.name);
    }
    return report;
  }

  /**
   * The assembled tool list: native tools first, in declaration order, then
   * augmented tools. Ordering is stable so prompt caching upstream stays
   * effective across turns.
   */
  list(): ToolDescriptor[] {
    const names = [...this.nativeOrder, ...this.augmentedOrder];
    return names.map((name) => this.byName.get(name)!).filter(Boolean);
  }

  /** Native tool names that must be forwarded even when the list is trimmed. */
  requiredNames(): string[] {
    const required = new Set(this.policy.nativeAllowList);
    return this.nativeOrder.filter((name) => required.size === 0 || required.has(name));
  }

  get(name: string): ToolDescriptor | undefined {
    return this.byName.get(name);
  }

  originOf(name: string): ToolOrigin | undefined {
    return this.byName.get(name)?.origin;
  }

  snapshot(): ToolRegistrySnapshot {
    return {
      native: this.nativeOrder.length,
      augmented: this.augmentedOrder.length,
      names: [...this.nativeOrder, ...this.augmentedOrder],
    };
  }
}
