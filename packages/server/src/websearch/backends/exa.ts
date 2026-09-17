/**
 * Exa, a neural search API.
 *
 * `contents.text` is requested so a search returns usable extracts in one
 * call; without it the model has to follow every result with a fetch, which
 * costs a round trip per link.
 */

import { httpCall, readJson } from '@mycursor/providers';

import type { BackendCallOptions, SearchBackend, SearchResult } from '../types.js';

interface ExaResponse {
  results?: { title?: string; url?: string; text?: string; summary?: string }[];
}

export const exa: SearchBackend = {
  id: 'exa',
  label: 'Exa',
  requiresApiKey: true,

  async search(query, options) {
    const response = await httpCall({
      url: 'https://api.exa.ai/search',
      method: 'POST',
      headers: { 'x-api-key': options.apiKey, accept: 'application/json' },
      body: {
        query,
        numResults: options.maxResults,
        type: 'auto',
        contents: { text: { maxCharacters: 2_000 } },
      },
      proxyUrl: options.proxyUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30_000,
      retries: 1,
    });

    const payload = await readJson<ExaResponse>(response.stream);
    return (payload.results ?? [])
      .filter((result) => result.url)
      .slice(0, options.maxResults)
      .map((result) => ({
        title: result.title ?? result.url ?? '',
        url: result.url ?? '',
        snippet: (result.summary ?? result.text ?? '').trim(),
      }));
  },
};
