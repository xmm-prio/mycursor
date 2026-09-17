/**
 * Firecrawl, which searches and scrapes.
 *
 * Like Jina it can render a page to Markdown, so it also backs `web_fetch`.
 * Unlike Jina its search returns scrape results, so the snippet may be the
 * page body rather than a summary — it is truncated by the caller rather than
 * here, so the trimming rule stays in one place.
 */

import { httpCall, readJson } from '@mycursor/providers';

import type { BackendCallOptions, SearchBackend, SearchResult } from '../types.js';

interface FirecrawlSearchResponse {
  data?: { title?: string; url?: string; description?: string; markdown?: string }[];
}

interface FirecrawlScrapeResponse {
  data?: { markdown?: string; content?: string };
}

export const firecrawl: SearchBackend = {
  id: 'firecrawl',
  label: 'Firecrawl',
  requiresApiKey: true,

  async search(query, options) {
    const response = await httpCall({
      url: 'https://api.firecrawl.dev/v1/search',
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
      body: { query, limit: options.maxResults },
      proxyUrl: options.proxyUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30_000,
      retries: 1,
    });

    const payload = await readJson<FirecrawlSearchResponse>(response.stream);
    return (payload.data ?? [])
      .filter((result) => result.url)
      .slice(0, options.maxResults)
      .map((result) => ({
        title: result.title ?? result.url ?? '',
        url: result.url ?? '',
        snippet: (result.description ?? result.markdown ?? '').trim(),
      }));
  },

  async read(url, options) {
    const response = await httpCall({
      url: 'https://api.firecrawl.dev/v1/scrape',
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
      body: { url, formats: ['markdown'] },
      proxyUrl: options.proxyUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 40_000,
      retries: 1,
    });

    const payload = await readJson<FirecrawlScrapeResponse>(response.stream);
    return payload.data?.markdown ?? payload.data?.content ?? '';
  },
};
