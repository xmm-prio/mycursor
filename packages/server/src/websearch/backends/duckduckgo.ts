/**
 * DuckDuckGo, via the HTML endpoint.
 *
 * The only backend that needs no account, which is why it is the default: a
 * user who turns web search on should get working search before they go and
 * sign up for anything.
 *
 * There is no official API, so this parses the lite HTML page. That is a
 * fragile contract and the parsing is written to degrade to "no results"
 * rather than to throw — an empty result set tells the model to try something
 * else, whereas an exception aborts a turn the user was in the middle of.
 */

import { httpCall, readAll } from '@mycursor/providers';

import type { BackendCallOptions, SearchBackend, SearchResult } from '../types.js';

const ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * Results are anchors of class `result__a` followed by a `result__snippet`.
 * Both classes have been stable for years, but see the note above.
 */
const RESULT_PATTERN =
  /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const SNIPPET_PATTERN = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

export const duckduckgo: SearchBackend = {
  id: 'duckduckgo',
  label: 'DuckDuckGo',
  requiresApiKey: false,

  async search(query, options) {
    const response = await httpCall({
      url: `${ENDPOINT}?q=${encodeURIComponent(query)}`,
      method: 'GET',
      headers: {
        // The endpoint serves a stripped page to unknown agents.
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        accept: 'text/html',
      },
      proxyUrl: options.proxyUrl,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 20_000,
      retries: 1,
    });

    const html = await readAll(response.stream);
    return parse(html, options.maxResults);
  },
};

function parse(html: string, limit: number): SearchResult[] {
  const snippets: string[] = [];
  for (const match of html.matchAll(SNIPPET_PATTERN)) snippets.push(stripTags(match[1] ?? ''));

  const results: SearchResult[] = [];
  let index = 0;
  for (const match of html.matchAll(RESULT_PATTERN)) {
    const url = resolveRedirect(match[1] ?? '');
    const title = stripTags(match[2] ?? '');
    if (url && title) {
      results.push({ title, url, snippet: snippets[index] ?? '' });
      if (results.length >= limit) break;
    }
    index += 1;
  }
  return results;
}

/**
 * Unwraps the click-tracking redirect.
 *
 * Handing the model a `duckduckgo.com/l/?uddg=…` URL would make every
 * follow-up fetch go through the tracker, and the model cannot tell from the
 * URL what site it is about to read.
 */
function resolveRedirect(href: string): string {
  const decoded = decodeEntities(href);
  const match = /[?&]uddg=([^&]+)/.exec(decoded);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return decoded;
    }
  }
  return decoded.startsWith('//') ? `https:${decoded}` : decoded;
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
