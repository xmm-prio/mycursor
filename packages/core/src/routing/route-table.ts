/**
 * Compiled, immutable view of a route rule list.
 *
 * Compilation happens once per configuration revision; matching is then a
 * constant-time set lookup on the hot path, which matters because every
 * outbound request in the patched process passes through it.
 */

import { normalisePath, parseRule, splitRpcPath, type RouteRule } from './rules.js';

export interface RouteTableStats {
  services: number;
  methods: number;
  restExact: number;
  restPrefix: number;
}

export class RouteTable {
  private readonly services = new Map<string, RouteRule>();
  private readonly methods = new Map<string, RouteRule>();
  private readonly restExact = new Map<string, RouteRule>();
  private readonly restPrefixes: RouteRule[] = [];

  private constructor(rules: readonly RouteRule[]) {
    for (const rule of rules) {
      switch (rule.kind) {
        case 'service':
          this.services.set(rule.value, rule);
          break;
        case 'method':
          this.methods.set(rule.value, rule);
          break;
        case 'rest':
          if (rule.prefix) this.restPrefixes.push(rule);
          else this.restExact.set(rule.value, rule);
          break;
      }
    }
    // Longest prefix first, so the most specific REST rule wins.
    this.restPrefixes.sort((a, b) => b.value.length - a.value.length);
  }

  /**
   * Compiles a rule list. Unusable entries are reported as warnings rather
   * than thrown, so one bad hand-edited line cannot disable the whole table.
   */
  static compile(rules: readonly string[]): { table: RouteTable; warnings: string[] } {
    const parsed: RouteRule[] = [];
    const warnings: string[] = [];
    for (const raw of rules) {
      if (typeof raw !== 'string') {
        warnings.push(`ignored non-string route rule: ${JSON.stringify(raw)}`);
        continue;
      }
      const rule = parseRule(raw);
      if (!rule) {
        if (raw.trim() && !raw.trim().startsWith('#')) {
          warnings.push(`ignored malformed route rule: ${JSON.stringify(raw)}`);
        }
        continue;
      }
      parsed.push(rule);
    }
    return { table: new RouteTable(parsed), warnings };
  }

  static empty(): RouteTable {
    return new RouteTable([]);
  }

  /** Returns the rule that claims `rawPath`, or null when nothing matches. */
  match(rawPath: string): RouteRule | null {
    const path = normalisePath(rawPath);
    if (path.length < 2) return null;

    const exact = this.restExact.get(path);
    if (exact) return exact;

    for (const rule of this.restPrefixes) {
      if (path.startsWith(rule.value)) return rule;
    }

    const rpc = splitRpcPath(path);
    if (!rpc) return null;

    return (
      this.methods.get(`${rpc.service}/${rpc.method}`) ?? this.services.get(rpc.service) ?? null
    );
  }

  /**
   * REST paths in the table. The renderer-side hook needs these to rewrite
   * `fetch` calls that never reach Node's http module.
   */
  restPaths(): string[] {
    return [
      ...this.restExact.keys(),
      ...this.restPrefixes.map((rule) => `${rule.value}*`),
    ];
  }

  stats(): RouteTableStats {
    return {
      services: this.services.size,
      methods: this.methods.size,
      restExact: this.restExact.size,
      restPrefix: this.restPrefixes.length,
    };
  }

  get size(): number {
    return this.services.size + this.methods.size + this.restExact.size + this.restPrefixes.length;
  }
}
