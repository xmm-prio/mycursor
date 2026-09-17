/**
 * Panel verification: the extension activated against a stubbed host.
 *
 * The panel is the surface a user actually touches, and it only runs inside
 * Cursor's extension host — which makes it exactly the kind of code that ships
 * broken. Stubbing the handful of `vscode` APIs it uses lets the real bundle
 * be activated, the real webview HTML rendered, and the real message handlers
 * exercised, all without launching an IDE.
 *
 * What is proven here: activation registers the sidebar view, the rendered
 * document is a valid sandboxed webview, the panel reads providers from disk,
 * and a save from the panel lands in `providers.json` in the shape the server
 * reads back.
 */

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const workDir = join(repoRoot, '.verify-out', 'panel');
const configHome = join(workDir, 'home');

process.env.MYCURSOR_HOME = configHome;

const checks = [];
function check(name, passed, detail) {
  checks.push({ name, passed, detail });
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

// --------------------------------------------------------- vscode stub ----

const posted = [];
let registeredProvider = null;
let registeredViewId = null;
const disposables = [];

function makeEvent() {
  const listeners = [];
  const event = (listener) => {
    listeners.push(listener);
    return { dispose() {} };
  };
  event.fire = (value) => listeners.forEach((listener) => listener(value));
  return event;
}

const webview = {
  html: '',
  options: {},
  cspSource: 'vscode-webview://stub',
  asWebviewUri: (uri) => ({ toString: () => `vscode-webview://stub${uri.fsPath.replace(/\\/g, '/')}` }),
  postMessage: (message) => {
    posted.push(message);
    return Promise.resolve(true);
  },
  onDidReceiveMessage: makeEvent(),
};

const webviewView = {
  webview,
  visible: true,
  onDidDispose: makeEvent(),
  onDidChangeVisibility: makeEvent(),
  show() {},
};

const vscodeStub = {
  Uri: {
    joinPath: (base, ...segments) => ({
      fsPath: join(base.fsPath, ...segments),
      toString: () => join(base.fsPath, ...segments),
    }),
    file: (path) => ({ fsPath: path, toString: () => path }),
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ text: '', show() {}, hide() {}, dispose() {} }),
    showInformationMessage: () => Promise.resolve(undefined),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showQuickPick: () => Promise.resolve(undefined),
    showTextDocument: () => Promise.resolve(undefined),
    registerWebviewViewProvider: (viewId, provider) => {
      registeredViewId = viewId;
      registeredProvider = provider;
      return { dispose() {} };
    },
  },
  workspace: {
    getConfiguration: () => ({
      get: (section, fallback) => (section === 'server.autoStart' ? false : fallback),
    }),
    openTextDocument: (path) => Promise.resolve({ fileName: path }),
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
  },
};

/**
 * Serves the stub to the bundle's `require('vscode')`.
 *
 * The extension host injects the module the same way, so this is the actual
 * resolution path rather than an approximation.
 */
const require_ = createRequire(import.meta.url);
const Module = require_('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// --------------------------------------------------------------- run -----

async function main() {
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(configHome, { recursive: true });
  console.log('mycursor panel verification');

  // A provider document the panel should read back.
  writeFileSync(
    join(configHome, 'providers.json'),
    `${JSON.stringify(
      {
        $schemaVersion: 2,
        providers: [
          {
            id: 'seed',
            name: 'Seeded provider',
            type: 'anthropic-messages',
            baseUrl: '',
            authValue: 'secret-key',
            headers: { 'anthropic-beta': 'context-1m-2025-08-07' },
            enabled: true,
            models: [
              {
                id: 'seeded-model',
                apiModel: 'claude-sonnet-4',
                displayName: 'Seeded Model',
                enabled: true,
                capabilities: {
                  agent: true,
                  images: true,
                  cmdK: false,
                  fast: false,
                  thinking: true,
                  thinkingLevel: 'high',
                },
                contextTokenLimit: 200000,
                maxOutputTokens: 64000,
                quickSwitch: { reasoningLevels: ['low', 'high'], contextOptions: [], fastToggle: true },
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );

  const extensionPath = join(repoRoot, 'packages', 'extension');
  const bundle = require_(join(extensionPath, 'dist', 'extension.cjs'));

  console.log('\n── Activation');
  check('bundle exports activate and deactivate',
    typeof bundle.activate === 'function' && typeof bundle.deactivate === 'function');

  bundle.activate({
    subscriptions: disposables,
    extensionPath,
    extensionUri: vscodeStub.Uri.file(extensionPath),
  });

  check('sidebar view provider registered', registeredViewId === 'mycursor.panel', registeredViewId);
  check('provider implements resolveWebviewView',
    typeof registeredProvider?.resolveWebviewView === 'function');

  console.log('\n── Webview document');
  registeredProvider.resolveWebviewView(webviewView);
  const html = webview.html;

  check('scripts are enabled with a restricted resource root',
    webview.options.enableScripts === true && Array.isArray(webview.options.localResourceRoots));
  const nonce = html.match(/nonce-([A-Za-z0-9]{32})/)?.[1];
  check('a per-load nonce is issued and used by the script tag',
    Boolean(nonce) && html.includes(`<script nonce="${nonce}"`), nonce ? `${nonce.slice(0, 8)}…` : 'none');
  check("the policy forbids inline script and 'unsafe-eval'",
    html.includes("default-src 'none'") && !html.includes('unsafe-inline') && !html.includes('unsafe-eval'));
  check('stylesheet and script resolve to webview URIs',
    html.includes('vscode-webview://stub') && !html.includes('__STYLE_URI__') && !html.includes('__SCRIPT_URI__'));

  for (const marker of ['Base URL', 'Auth Value', 'Proxy URL', 'Custom Headers', 'API Model', 'Context Token Limit', 'Max Output Tokens', 'Tooltip Markdown', 'QuickSwitch Options', 'Fast Toggle', '+ Add Model', '↓ Fetch', 'Web Search', 'Backend', 'Max Results', 'web_fetch']) {
    check(`form renders "${marker}"`, html.includes(marker));
  }

  console.log('\n── State round trip');
  posted.length = 0;
  webview.onDidReceiveMessage.fire({ type: 'ready' });
  await settle();

  const state = posted.find((message) => message.type === 'state');
  check('panel answers "ready" with state', Boolean(state));
  check('state carries the provider from disk',
    state?.providers?.length === 1 && state.providers[0].name === 'Seeded provider',
    state?.providers?.[0]?.name);
  check('model capabilities survive the read',
    state?.providers?.[0]?.models?.[0]?.capabilities?.thinkingLevel === 'high' &&
      state.providers[0].models[0].capabilities.images === true &&
      state.providers[0].models[0].capabilities.cmdK === false);
  check('quick-switch options survive the read',
    JSON.stringify(state?.providers?.[0]?.models?.[0]?.quickSwitch?.reasoningLevels) === '["low","high"]' &&
      state.providers[0].models[0].quickSwitch.fastToggle === true);
  check('custom headers survive the read',
    state?.providers?.[0]?.headers?.['anthropic-beta'] === 'context-1m-2025-08-07');
  check('state offers the provider types and thinking levels the form needs',
    state?.options?.types?.length === 3 && state.options.thinkingLevels.length === 5,
    `${state?.options?.types?.length} types, ${state?.options?.thinkingLevels?.length} levels`);
  check('state reports the server as offline when it is not running',
    state?.server?.online === false);
  check('state carries the web search settings',
    state?.webSearch?.enabled === false && state.webSearch.backend === 'duckduckgo',
    JSON.stringify({ enabled: state?.webSearch?.enabled, backend: state?.webSearch?.backend }));
  // The panel hides the key field for backends that need no account, so it
  // has to be told which those are.
  const backends = state?.options?.searchBackends ?? [];
  check('state names every search backend and whether it needs a key',
    backends.length === 6 && backends.find((entry) => entry.id === 'duckduckgo')?.requiresApiKey === false &&
      backends.find((entry) => entry.id === 'brave')?.requiresApiKey === true,
    backends.map((entry) => entry.id).join(', '));

  console.log('\n── Saving from the panel');
  posted.length = 0;
  const edited = structuredClone(state.providers);
  edited[0].name = 'Renamed provider';
  edited[0].models[0].capabilities.cmdK = true;
  edited.push({
    id: 'added',
    name: 'Added provider',
    type: 'openai-chat',
    baseUrl: '',
    authValue: 'another-key',
    enabled: true,
    models: [
      {
        id: 'added-model',
        apiModel: 'gpt-4.1',
        displayName: 'Added Model',
        enabled: true,
        capabilities: { agent: true, images: false, cmdK: true, fast: true, thinking: false, thinkingLevel: 'medium' },
        contextTokenLimit: 1000000,
        maxOutputTokens: 32768,
        tooltipMarkdown: '**Added** via the panel',
        quickSwitch: { reasoningLevels: [], contextOptions: ['default', 'extended'], fastToggle: false },
      },
    ],
  });
  webview.onDidReceiveMessage.fire({
    type: 'save',
    providers: edited,
    // Web search lives in config.json, but one Save has to take both.
    webSearch: { enabled: true, backend: 'tavily', apiKey: 'tvly-key', maxResults: 8 },
  });
  await settle();

  const written = JSON.parse(readFileSync(join(configHome, 'providers.json'), 'utf-8'));
  check('save wrote both providers', written.providers?.length === 2,
    written.providers?.map((entry) => entry.name).join(', '));
  check('the edit was persisted', written.providers?.[0]?.name === 'Renamed provider');
  check('the added model kept its tooltip and context options',
    written.providers?.[1]?.models?.[0]?.tooltipMarkdown === '**Added** via the panel' &&
      JSON.stringify(written.providers[1].models[0].quickSwitch.contextOptions) === '["default","extended"]');
  check('the auth value was not lost on the round trip',
    written.providers?.[0]?.authValue === 'secret-key' && written.providers[1].authValue === 'another-key');

  const after = posted.find((message) => message.type === 'state');
  check('the panel refreshes itself after saving', Boolean(after) && after.providers.length === 2);

  const savedConfig = JSON.parse(readFileSync(join(configHome, 'config.json'), 'utf-8'));
  check('one Save also wrote the web search settings to config.json',
    savedConfig.webSearch?.enabled === true && savedConfig.webSearch.backend === 'tavily' &&
      savedConfig.webSearch.maxResults === 8,
    JSON.stringify(savedConfig.webSearch));
  check('saving web search left the rest of the configuration intact',
    Array.isArray(savedConfig.redirect) && savedConfig.redirect.length > 0 &&
      savedConfig.tools?.preserveNative === true,
    `${savedConfig.redirect?.length} routes`);
  check('the refreshed state reports the new web search settings',
    after?.webSearch?.backend === 'tavily', after?.webSearch?.backend);

  console.log('\n── The saved document is what the server reads');
  const { ProviderRegistry } = await import('@mycursor/providers');
  const registry = ProviderRegistry.fromDocument(written);
  check('server registry accepts the panel output',
    registry.size === 2 && registry.allModels().length === 2,
    `${registry.size} providers, ${registry.allModels().length} models`);
  check('model ids resolve to their provider',
    Boolean(registry.resolve('seeded-model')) && Boolean(registry.resolve('added-model')));

  bundle.deactivate();

  const failed = checks.filter((entry) => !entry.passed);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.log('failed checks:');
    for (const entry of failed) console.log(`  - ${entry.name}: ${entry.detail ?? ''}`);
    process.exitCode = 1;
  }
}

/** Lets the panel's async message handlers finish. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 250));
}

await main();
