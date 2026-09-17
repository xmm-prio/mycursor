/**
 * Brave Search API.
 *
 * Brave returns several result verticals; only `web` is read. News and video
 * results carry different field shapes and would need their own rendering to
 * be useful, and mixing them silently would make the result list inconsistent
 * between queries.
 */

import { httpCall, readJson } from '@mycursor/providers';

import type { BackendCallOptions, SearchBackend, SearchResult } from '../types.js';

interface BraveResponse {
  web?: { results?: { title?: string; url?: string; description?: string }[] };
}

export const brave: SearchBackend = {
  id: 'brave',
  label: 'Brave Search',
  requiresApiKey: true,

  async search(query, options) {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(options.maxResults));

    const response = await httpCall({
      url: url.toString(),
      method: 'GET',
      headers: {
        'x-subscription-token': options.apiKey,
        accept: 'application/json',
        'accept-encoding': 'identity',
      },
      proxyUrl: options.proxyUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30_000,
      retries: 1,
    });

    const payload = await readJson<BraveResponse>(response.stream);
    return (payload.web?.results ?? [])
      .filter((result) => result.url)
      .slice(0, options.maxResults)
      .map((result) => ({
        title: result.title ?? result.url ?? '',
        url: result.url ?? '',
        snippet: (result.description ?? '').replace(/<[^>]*>/g, '').trim(),
      }));
  },
};
