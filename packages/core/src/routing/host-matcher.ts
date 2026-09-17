/**
 * Host-level candidacy test.
 *
 * The socket-level interception layer sees a connection before any request
 * path exists, so host matching has to stand on its own. Keeping it separate
 * from path matching also means an operator can widen or narrow the captured
 * host set without touching the route table.
 */

export function normaliseHost(host: string | undefined | null): string {
  return String(host ?? '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
}

export class HostMatcher {
  private readonly patterns: RegExp[];
  private readonly cache = new Map<string, boolean>();

  private constructor(patterns: RegExp[]) {
    this.patterns = patterns;
  }

  /**
   * Compiles regex sources. An invalid source is reported and skipped so a
   * single typo cannot make the matcher reject every host.
   */
  static compile(sources: readonly string[]): { matcher: HostMatcher; warnings: string[] } {
    const patterns: RegExp[] = [];
    const warnings: string[] = [];
    for (const source of sources) {
      if (typeof source !== 'string' || !source.trim()) {
        warnings.push(`ignored empty host pattern: ${JSON.stringify(source)}`);
        continue;
      }
      try {
        patterns.push(new RegExp(source, 'i'));
      } catch (error) {
        warnings.push(
          `ignored invalid host pattern ${JSON.stringify(source)}: ${(error as Error).message}`,
        );
      }
    }
    return { matcher: new HostMatcher(patterns), warnings };
  }

  static empty(): HostMatcher {
    return new HostMatcher([]);
  }

  matches(host: string | undefined | null): boolean {
    const normalised = normaliseHost(host);
    if (!normalised) return false;
    const cached = this.cache.get(normalised);
    if (cached !== undefined) return cached;
    const result = this.patterns.some((pattern) => pattern.test(normalised));
    // Bounded so a hostile or noisy host set cannot grow the cache without limit.
    if (this.cache.size < 512) this.cache.set(normalised, result);
    return result;
  }

  get size(): number {
    return this.patterns.length;
  }
}
