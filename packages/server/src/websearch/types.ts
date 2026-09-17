/**
 * Web search as a server-side tool.
 *
 * Cursor's own web search runs on its backend, so a BYOK session loses it:
 * the tool is in the protocol catalogue, the model calls it, and the client
 * has nothing to run. Supplying a replacement here keeps the capability,
 * and — unlike the native one — lets the user pick who does the searching.
 *
 * Backends are deliberately thin. Each one turns a query into a list of
 * results; none of them knows about tools, turns or protobuf.
 */

export const WEB_SEARCH_BACKENDS = [
  'duckduckgo',
  'exa',
  'tavily',
  'brave',
  'jina',
  'firecrawl',
] as const;

export type WebSearchBackendId = (typeof WEB_SEARCH_BACKENDS)[number];

export interface SearchResult {
  title: string;
  url: string;
  /** Extract or summary; empty when the backend returns none. */
  snippet: string;
}

export interface BackendCallOptions {
  apiKey: string;
  maxResults: number;
  proxyUrl?: string | undefined;
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

export interface SearchBackend {
  readonly id: WebSearchBackendId;
  /** Human-readable name, used in diagnostics and the panel. */
  readonly label: string;
  /** False for backends usable without signing up, which makes them the default. */
  readonly requiresApiKey: boolean;
  search(query: string, options: BackendCallOptions): Promise<SearchResult[]>;
  /**
   * Reads a page as text.
   *
   * Only the reader backends implement this; the rest leave it undefined so
   * the provider can tell whether `web_fetch` can be offered at all.
   */
  read?(url: string, options: BackendCallOptions): Promise<string>;
}

/** Raised when a backend is configured but cannot run. */
export class WebSearchError extends Error {
  constructor(message: string, readonly backend: WebSearchBackendId) {
    super(message);
    this.name = 'WebSearchError';
  }
}
