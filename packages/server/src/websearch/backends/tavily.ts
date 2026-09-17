/**
 * Tavily, a search API built for LLM use.
 *
 * `include_answer` is deliberately off: a backend-written answer would enter
 * the conversation as if the model had reasoned to it, and the model cannot
 * tell which part of its context it actually verified.
 */

import { httpCall, readJson } from '@mycursor/providers';

import type { BackendCallOptions, SearchBackend, SearchResult } from '../types.js';

interface TavilyResponse {
  results?: { title?: string; url?: string; content?: string; raw_content?: string }[];
}

export const tavily: SearchBackend = {
  id: 'tavily',
  label: 'Tavily',
  requiresApiKey: true,

  async search(query, options) {
    const response = await httpCall({
      url: 'https://api.tavily.com/search',
      method: 'POST',
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
      body: {
        query,
        max_results: options.maxResults,
        search_depth: 'basic',
        include_answer: false,
      },
      proxyUrl: options.proxyUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 30_000,
      retries: 1,
    });

    const payload = await readJson<TavilyResponse>(response.stream);
    return (payload.results ?? [])
      .filter((result) => result.url)
      .slice(0, options.maxResults)
      .map((result) => ({
        title: result.title ?? result.url ?? '',
        url: result.url ?? '',
        snippet: (result.content ?? result.raw_content ?? '').trim(),
      }));
  },
};
