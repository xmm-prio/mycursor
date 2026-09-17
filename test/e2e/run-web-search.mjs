/**
 * Web search: the capability a BYOK session loses by default.
 *
 * Cursor's own web search runs on its backend. Once traffic is served
 * locally the tool is still in the catalogue, the model still calls it, and
 * nothing answers — so the replacement here has to do two things Cursor's
 * tools never do: be declared by the server *and* be executed by it.
 *
 * Two properties matter most and are asserted directly:
 *  - the search must never displace a tool the client declared;
 *  - the model's call must be resolved inside the turn, because a server
 *    tool result has nowhere else to live.
 *
 * The six backends run unmodified against a mock reached through the proxy
 * path, so the real URLs, headers and parsers are all exercised.
 */

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultConfig, normaliseConfig } from '@mycursor/core/config';
import { Logger } from '@mycursor/core/logging';
import { assembleTools, TurnRunner, WebSearchToolProvider } from '@mycursor/server';
import { ProviderRegistry } from '@mycursor/providers';

import { startMockProvider } from '../harness/lib/mock-provider.mjs';
import { startMockSearch } from '../harness/lib/mock-search.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const workDir = join(here, '..', '..', '.verify-out', 'web-search');

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const quiet = new Logger({ scope: 'verify', level: 'error' });

const settings = (overrides) => ({
  enabled: true,
  backend: 'duckduckgo',
  apiKey: '',
  maxResults: 5,
  allowFetch: true,
  ...overrides,
});

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  console.log('mycursor web search verification');

  const search = await startMockSearch({ tlsDirectory: workDir });

  try {
    // ------------------------------------------------- the six backends ----

    console.log('\n── Every backend runs against its own real URL');

    const expectations = [
      { backend: 'duckduckgo', apiKey: '', host: 'html.duckduckgo.com', title: 'Node.js fs & docs' },
      { backend: 'exa', apiKey: 'exa-key', host: 'api.exa.ai', title: 'Exa hit' },
      { backend: 'tavily', apiKey: 'tavily-key', host: 'api.tavily.com', title: 'Tavily hit' },
      { backend: 'brave', apiKey: 'brave-key', host: 'api.search.brave.com', title: 'Brave hit' },
      { backend: 'jina', apiKey: 'jina-key', host: 's.jina.ai', title: 'Jina hit' },
      { backend: 'firecrawl', apiKey: 'fire-key', host: 'api.firecrawl.dev', title: 'Firecrawl hit' },
    ];

    for (const expected of expectations) {
      const provider = new WebSearchToolProvider(
        () => settings({ backend: expected.backend, apiKey: expected.apiKey, proxyUrl: search.proxyUrl }),
        quiet,
      );
      const result = await provider.execute('web_search', { query: 'node fs api' });
      const seen = search.requests.at(-1);
      check(`${expected.backend} reached its own endpoint and parsed the reply`,
        seen?.host === expected.host && result.includes(expected.title),
        `${seen?.host}${seen?.path ?? ''}`);
    }

    console.log('\n── Credentials go where each service expects them');

    const authChecks = [
      { backend: 'exa', apiKey: 'exa-key', header: 'x-api-key', value: 'exa-key' },
      { backend: 'tavily', apiKey: 'tavily-key', header: 'authorization', value: 'Bearer tavily-key' },
      { backend: 'brave', apiKey: 'brave-key', header: 'x-subscription-token', value: 'brave-key' },
      { backend: 'jina', apiKey: 'jina-key', header: 'authorization', value: 'Bearer jina-key' },
      { backend: 'firecrawl', apiKey: 'fire-key', header: 'authorization', value: 'Bearer fire-key' },
    ];
    for (const expected of authChecks) {
      const provider = new WebSearchToolProvider(
        () => settings({ backend: expected.backend, apiKey: expected.apiKey, proxyUrl: search.proxyUrl }),
        quiet,
      );
      await provider.execute('web_search', { query: 'x' });
      const seen = search.requests.at(-1);
      check(`${expected.backend} sends its key as ${expected.header}`,
        seen?.headers?.[expected.header] === expected.value,
        seen?.headers?.[expected.header]);
    }

    console.log('\n── Result shaping');

    const ddg = new WebSearchToolProvider(
      () => settings({ proxyUrl: search.proxyUrl }),
      quiet,
    );
    const rendered = await ddg.execute('web_search', { query: 'node fs api' });
    // A tracker URL would send every follow-up fetch through DuckDuckGo and
    // hide the real site from the model.
    check('the DuckDuckGo redirect was unwrapped to the real URL',
      rendered.includes('https://nodejs.org/api/fs.html') && !rendered.includes('uddg='),
      rendered.split('\n')[2]?.trim());
    check('HTML entities in titles were decoded', rendered.includes('Node.js fs & docs'));
    check('snippets came through without their markup',
      rendered.includes('The fs module enables file system access.'));
    check('results are numbered so the model can cite one',
      rendered.includes('1. ') && rendered.includes('2. '));

    const capped = await ddg.execute('web_search', { query: 'node fs api', max_results: 1 });
    check('the model can narrow the result count',
      capped.includes('1. ') && !capped.includes('2. '));

    console.log('\n── Reading a page');

    const reader = new WebSearchToolProvider(
      () => settings({ backend: 'jina', apiKey: 'jina-key', proxyUrl: search.proxyUrl }),
      quiet,
    );
    const page = await reader.execute('web_fetch', { url: 'https://example.com/doc' });
    check('a reader backend returns the page as text', page.includes('The page as Markdown.'));
    check('web_fetch is offered when the backend can read',
      reader.tools().some((tool) => tool.name === 'web_fetch'),
      reader.tools().map((tool) => tool.name).join(', '));
    check('web_fetch is not offered when the backend cannot read',
      !ddg.tools().some((tool) => tool.name === 'web_fetch'),
      ddg.tools().map((tool) => tool.name).join(', '));
    check('a non-http URL is refused rather than fetched',
      (await reader.execute('web_fetch', { url: 'file:///etc/passwd' })).includes('not an http(s) URL'));

    console.log('\n── Degrading instead of aborting the turn');

    const broken = await startMockSearch({ tlsDirectory: workDir, fail: new Set(['api.tavily.com']) });
    try {
      const failing = new WebSearchToolProvider(
        () => settings({ backend: 'tavily', apiKey: 'k', proxyUrl: broken.proxyUrl }),
        quiet,
      );
      const message = await failing.execute('web_search', { query: 'x' });
      // The user is mid-turn; an exception here would discard the answer.
      check('a failing service comes back as text the model can react to',
        message.includes('Tavily') && message.includes('500'), message.slice(0, 90));
    } finally {
      await broken.close();
    }

    const unkeyed = new WebSearchToolProvider(() => settings({ backend: 'exa', apiKey: '' }), quiet);
    check('a backend with no API key is not offered at all',
      unkeyed.tools().length === 0, `${unkeyed.tools().length} tools`);
    const disabled = new WebSearchToolProvider(() => settings({ enabled: false }), quiet);
    check('the tools disappear when web search is switched off',
      disabled.tools().length === 0, `${disabled.tools().length} tools`);

    // ------------------------------------------- the native tool promise ----

    console.log('\n── Cursor\'s own tools still come first');

    const policy = createDefaultConfig().tools;
    const nativeTools = [
      { name: 'read', description: 'Read a file', origin: 'native' },
      { name: 'web_search', description: "Cursor's own web search", origin: 'native' },
    ];
    const assembly = assembleTools({
      nativeTools,
      policy,
      serverProviders: [ddg],
    });
    check('a client-declared web_search is not replaced by the server one',
      assembly.tools.find((tool) => tool.name === 'web_search')?.description ===
        "Cursor's own web search",
      assembly.tools.find((tool) => tool.name === 'web_search')?.description);
    check('the shadowed server tool is reported rather than silently dropped',
      assembly.report.shadowed.includes('web_search'), assembly.report.shadowed.join(', '));
    check('a shadowed server tool is not executable here either',
      !assembly.executors.has('web_search'), [...assembly.executors.keys()].join(', '));

    const clean = assembleTools({
      nativeTools: [{ name: 'read', description: 'Read a file', origin: 'native' }],
      policy,
      serverProviders: [ddg],
    });
    check('the server tool is added when the client has no equivalent',
      clean.tools.map((tool) => tool.name).join(',') === 'read,web_search',
      clean.tools.map((tool) => tool.name).join(', '));
    check('the added tool is executable', clean.executors.has('web_search'));

    const denied = assembleTools({
      nativeTools: [{ name: 'read', origin: 'native' }],
      policy: { ...policy, augmentationDenyList: ['web_search'] },
      serverProviders: [ddg],
    });
    check('the deny list keeps the tool out and unexecutable',
      !denied.tools.some((tool) => tool.name === 'web_search') && !denied.executors.has('web_search'),
      denied.report.denied.join(', '));

    // ----------------------------------------- the turn executes it inline --

    console.log('\n── The model\'s call is resolved inside the turn');

    const model = await startMockProvider({
      toolCall: { name: 'web_search', argumentsJson: '{"query":"node fs api"}' },
      // The second response has no tool call, which ends the loop.
      followUpText: 'Node exposes the fs module.',
    });
    try {
      const registry = ProviderRegistry.fromDocument({
        $schemaVersion: 2,
        providers: [
          {
            id: 'mock',
            name: 'Mock',
            type: 'openai-chat',
            baseUrl: model.baseUrl,
            authValue: 'k',
            enabled: true,
            models: [{ id: 'm', apiModel: 'mock-model', displayName: 'M', enabled: true }],
          },
        ],
      });

      const runner = new TurnRunner({
        providers: () => registry,
        toolPolicy: () => policy,
        serverTools: () => [ddg],
        logger: quiet,
      });

      const events = [];
      for await (const event of runner.run({
        model: 'm',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'what is node fs' }] }],
        nativeTools: [{ name: 'read', origin: 'native' }],
      })) {
        events.push(event);
      }

      const forwarded = events.filter((event) => event.type === 'tool-call');
      check('the server tool call never reached the client',
        forwarded.length === 0, `${forwarded.length} forwarded`);

      const ran = events.find((event) => event.type === 'server-tool');
      check('the runner reported executing it', ran?.name === 'web_search', ran?.name);
      check('the search actually ran against the backend',
        search.requests.at(-1)?.host === 'html.duckduckgo.com',
        search.requests.at(-1)?.host);

      const text = events.filter((event) => event.type === 'text').map((event) => event.delta).join('');
      check('the model answered using the result',
        text.includes('Node exposes the fs module.'), JSON.stringify(text));

      // The second call is where the loop proves itself: the provider must
      // have been re-asked with the tool result appended.
      const second = model.requests.at(-1);
      const roles = (second?.messages ?? []).map((message) => message.role);
      check('the provider was asked again with the result appended',
        roles.join(',') === 'user,assistant,tool', roles.join(','));
      check('the tool message carried the search output',
        String(second?.messages?.at(-1)?.content ?? '').includes('nodejs.org/api/fs.html'),
        String(second?.messages?.at(-1)?.content ?? '').slice(0, 70));
    } finally {
      await model.close();
    }

    console.log('\n── Configuration');

    const configPath = join(workDir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ webSearch: { enabled: true, backend: 'brave', maxResults: 99 } }));
    const { config, warnings } = normaliseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
    check('the panel\'s choice of backend survives normalisation',
      config.webSearch.backend === 'brave', config.webSearch.backend);
    check('an out-of-range result count is clamped with a warning',
      config.webSearch.maxResults === 5 && warnings.some((entry) => entry.includes('maxResults')),
      `${config.webSearch.maxResults}; ${warnings.filter((entry) => entry.includes('maxResults')).join('')}`);
    check('web search is off in a default configuration',
      createDefaultConfig().webSearch.enabled === false);
  } finally {
    await search.close();
  }

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed checks:');
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail ?? ''}`);
    process.exitCode = 1;
  }
}

await main();
