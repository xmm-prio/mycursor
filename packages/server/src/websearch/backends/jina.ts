/**
 * Jina Reader, which both searches (`s.jina.ai`) and reads pages (`r.jina.ai`).
 *
 * The reader is the point: it renders a page to Markdown server-side, so the
 * model gets prose instead of the script tags and navigation chrome that a
 * raw fetch returns. That is what makes a `web_fetch` tool worth offering.
 */

import { httpCall, readAll, readJson } from '@mycursor/providers';

import type { BackendCallOptions, SearchBackend, SearchResult } from '../types.js';

interface JinaSearchResponse {
  data?: { title?: string; url?: string; description?: string; content?: string }[];
}

export const jina: SearchBackend = {
  id: 'jina',
  label: 'Jina Reader',
  requiresApiKey: true,

  async search(query, options) {
    const response = await httpCall({
      url: `https://s.jina.ai/${encodeURIComponent(query)}`,
      method: 'GET',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        accept: 'application/json',
        'x-respond-with': 'no-content',
      },
      proxyUrl: options.proxyUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30_000,
      retries: 1,
    });

    const payload = await readJson<JinaSearchResponse>(response.stream);
    return (payload.data ?? [])
      .filter((result) => result.url)
      .slice(0, options.maxResults)
      .map((result) => ({
        title: result.title ?? result.url ?? '',
        url: result.url ?? '',
        snippet: (result.description ?? result.content ?? '').trim(),
      }));
  },

  async read(url, options) {
    const response = await httpCall({
      url: `https://r.jina.ai/${url}`,
      method: 'GET',
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'text/plain' },
      proxyUrl: options.proxyUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 40_000,
      retries: 1,
    });
    return readAll(response.stream);
  },
};
