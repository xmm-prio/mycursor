/** The built-in search backends, keyed by the id used in configuration. */

import type { SearchBackend, WebSearchBackendId } from '../types.js';
import { brave } from './brave.js';
import { duckduckgo } from './duckduckgo.js';
import { exa } from './exa.js';
import { firecrawl } from './firecrawl.js';
import { jina } from './jina.js';
import { tavily } from './tavily.js';

export const BACKENDS: Readonly<Record<WebSearchBackendId, SearchBackend>> = {
  duckduckgo,
  exa,
  tavily,
  brave,
  jina,
  firecrawl,
};

export { brave, duckduckgo, exa, firecrawl, jina, tavily };
