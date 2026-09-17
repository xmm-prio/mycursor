/**
 * The `web_search` / `web_fetch` server tools.
 *
 * These are server tools rather than protocol tools, which means the server
 * both declares them *and* runs them: the Cursor client has no idea they
 * exist, so a call must never leave this process. The turn runner executes
 * them inline and feeds the result back to the model.
 *
 * They are strictly additive. If the client already declares a tool of the
 * same name — Cursor's own `web_search` when the user is signed in — the
 * registry keeps the client's and these step aside.
 */

import type { Logger } from '@mycursor/core/logging';
import type { ToolDescriptor } from '@mycursor/core/tools';

import type { ServerToolProvider } from '../agent/tool-assembly.js';
import { BACKENDS } from './backends/index.js';
import {
  WebSearchError,
  type BackendCallOptions,
  type SearchBackend,
  type SearchResult,
  type WebSearchBackendId,
} from './types.js';

export interface WebSearchSettings {
  enabled: boolean;
  backend: WebSearchBackendId;
  apiKey: string;
  maxResults: number;
  /** Offer `web_fetch` when the backend can read pages. */
  allowFetch: boolean;
  proxyUrl?: string | undefined;
}

/** Snippets are trimmed so one search cannot crowd out the conversation. */
const SNIPPET_LIMIT = 600;
const PAGE_LIMIT = 20_000;

export class WebSearchToolProvider implements ServerToolProvider {
  readonly id = 'web-search';

  constructor(
    private readonly settings: () => WebSearchSettings,
    private readonly logger: Logger,
  ) {}

  tools(): ToolDescriptor[] {
    const settings = this.settings();
    if (!settings.enabled) return [];

    const backend = BACKENDS[settings.backend];
    if (!backend) return [];
    if (backend.requiresApiKey && !settings.apiKey) {
      // Offering a tool that is certain to fail wastes a model turn and reads
      // as a broken tool rather than an unconfigured one.
      this.logger.warn('web search is enabled but the backend has no API key', {
        backend: settings.backend,
      });
      return [];
    }

    const tools: ToolDescriptor[] = [
      {
        name: 'web_search',
        description:
          'Search the web and return a ranked list of results with titles, URLs and extracts. ' +
          'Use it for information that may have changed since training, or to find a source to read.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'The search query.' },
            max_results: {
              type: 'integer',
              description: `Results to return; defaults to ${settings.maxResults}.`,
            },
          },
          required: ['query'],
        },
        origin: 'augmented',
      },
    ];

    if (settings.allowFetch && backend.read) {
      tools.push({
        name: 'web_fetch',
        description:
          'Fetch a web page and return it as readable text. Use it to read a result found with web_search.',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: 'Absolute URL of the page to read.' } },
          required: ['url'],
        },
        origin: 'augmented',
      });
    }

    return tools;
  }

  /**
   * Runs one of the tools.
   *
   * Failures come back as text rather than exceptions. The model is mid-turn
   * and can react to "the search failed, try another phrasing"; an exception
   * would abort the whole turn and lose whatever it had already written.
   */
  async execute(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const settings = this.settings();
    const backend = BACKENDS[settings.backend];
    if (!backend) return `Web search is not available: unknown backend "${settings.backend}".`;

    const options: BackendCallOptions = {
      apiKey: settings.apiKey,
      maxResults: settings.maxResults,
      proxyUrl: settings.proxyUrl,
      signal,
    };

    try {
      if (name === 'web_search') return await this.search(backend, args, options);
      if (name === 'web_fetch') return await this.fetch(backend, args, options);
      return `Unknown tool "${name}".`;
    } catch (error) {
      const message = (error as Error).message;
      this.logger.warn('a web search tool call failed', { tool: name, backend: backend.id, error: message });
      return `The ${backend.label} request failed: ${message}`;
    }
  }

  private async search(
    backend: SearchBackend,
    args: Record<string, unknown>,
    options: BackendCallOptions,
  ): Promise<string> {
    const query = String(args['query'] ?? '').trim();
    if (!query) return 'No query was supplied.';

    const requested = Number(args['max_results']);
    const limit = Number.isFinite(requested) && requested > 0
      ? Math.min(Math.trunc(requested), 20)
      : options.maxResults;

    const results = await backend.search(query, { ...options, maxResults: limit });
    this.logger.info('web search served', { backend: backend.id, results: results.length });

    if (results.length === 0) return `No results for "${query}".`;
    return render(query, results);
  }

  private async fetch(
    backend: SearchBackend,
    args: Record<string, unknown>,
    options: BackendCallOptions,
  ): Promise<string> {
    const url = String(args['url'] ?? '').trim();
    if (!url) return 'No URL was supplied.';
    if (!/^https?:\/\//i.test(url)) return `"${url}" is not an http(s) URL.`;
    if (!backend.read) {
      throw new WebSearchError(`${backend.label} cannot read pages`, backend.id);
    }

    const text = await backend.read(url, options);
    this.logger.info('web fetch served', { backend: backend.id, bytes: text.length });
    if (!text.trim()) return `${url} returned no readable text.`;
    return truncate(text, PAGE_LIMIT);
  }
}

/**
 * Renders results as Markdown.
 *
 * Numbered entries with the URL on its own line read well to a model and let
 * it cite a specific result back, which a JSON blob does not.
 */
function render(query: string, results: SearchResult[]): string {
  const blocks = results.map((result, index) => {
    const snippet = truncate(result.snippet.replace(/\s+/g, ' ').trim(), SNIPPET_LIMIT);
    return [`${index + 1}. ${result.title}`, `   ${result.url}`, snippet ? `   ${snippet}` : '']
      .filter(Boolean)
      .join('\n');
  });
  return [`Search results for "${query}":`, '', ...blocks].join('\n');
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…(truncated)`;
}
