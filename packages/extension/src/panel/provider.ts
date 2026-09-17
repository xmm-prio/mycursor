/**
 * The MyCursor sidebar panel.
 *
 * The panel is the only place a user should need to visit: it edits
 * `providers.json`, shows whether the server and schema are healthy, and
 * pushes changes out without a restart.
 *
 * All state lives in `providers.json` rather than in the webview. The panel
 * reads on open and writes on save, so a hand-edited file and the panel never
 * disagree, and closing Cursor mid-edit loses nothing that was saved.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as vscode from 'vscode';

import {
  loadConfigFrom,
  resolveConfigPaths,
  saveConfigTo,
  type WebSearchConfig,
} from '@mycursor/core/config';
import {
  createModel,
  createProvider,
  DEFAULT_BASE_URLS,
  normaliseProvider,
  PROVIDER_TYPES,
  readProvidersDocument,
  saveProvidersTo,
  THINKING_LEVELS,
  kindOfType,
  AnthropicProvider,
  GeminiProvider,
  OpenAiProvider,
  type CatalogEntry,
  type ProviderConfig,
} from '@mycursor/providers';
import {
  STATUS_PATH,
  TOGGLE_PATH,
  WEB_SEARCH_BACKENDS,
  WEB_SEARCH_BACKEND_IMPLEMENTATIONS,
  type ServerStatusReport,
} from '@mycursor/server';

/** Messages the webview sends to the extension. */
type Inbound =
  | { type: 'ready' }
  | { type: 'save'; providers: ProviderConfig[]; webSearch?: Partial<WebSearchConfig> }
  | { type: 'fetchModels'; provider: ProviderConfig }
  | { type: 'toggleByok' }
  | { type: 'restartServer' }
  | { type: 'openProvidersFile' }
  | { type: 'reload' };

export interface PanelDeps {
  log: (message: string) => void;
  restartServer: () => Promise<void>;
  ensureServer: () => Promise<void>;
}

export class MyCursorPanel implements vscode.WebviewViewProvider {
  static readonly viewId = 'mycursor.panel';

  private view: vscode.WebviewView | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly extensionPath: string,
    private readonly deps: PanelDeps,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.render(view.webview);

    view.webview.onDidReceiveMessage((raw) => {
      void this.handle(raw as Inbound);
    });
    view.onDidChangeVisibility(() => {
      // Re-reading on reveal keeps the panel honest about a file edited
      // elsewhere while it was hidden.
      if (view.visible) void this.pushState();
    });
  }

  /** Reveals the panel, or reports that the view has not been created yet. */
  reveal(): boolean {
    if (!this.view) return false;
    this.view.show(true);
    return true;
  }

  private async handle(message: Inbound): Promise<void> {
    switch (message.type) {
      case 'ready':
      case 'reload':
        await this.pushState();
        return;

      case 'save': {
        const paths = resolveConfigPaths();
        const providers = message.providers.map((entry, index) => normaliseProvider(entry, index));
        saveProvidersTo(paths.providers, { $schemaVersion: 2, providers });
        this.deps.log(`saved ${providers.length} provider(s) to ${paths.providers}`);

        // Web search lives in config.json rather than providers.json, but the
        // user made both edits in one form and expects one Save to take them.
        if (message.webSearch) {
          const current = loadConfigFrom(paths.config).config;
          saveConfigTo(paths.config, {
            ...current,
            webSearch: { ...current.webSearch, ...message.webSearch },
          });
          this.deps.log(`web search saved: ${message.webSearch.enabled ? message.webSearch.backend : 'off'}`);
        }

        // The server watches both files, but pushing state back immediately is
        // what makes the panel feel like it took the change.
        await this.pushState('Saved');
        return;
      }

      case 'fetchModels': {
        await this.fetchModels(message.provider);
        return;
      }

      case 'toggleByok': {
        const { server } = loadConfigFrom(resolveConfigPaths().config).config;
        try {
          const response = await fetch(`http://${server.host}:${server.port}${TOGGLE_PATH}`, {
            method: 'POST',
          });
          const body = (await response.json()) as { byokMode?: boolean };
          await this.pushState(`BYOK ${body.byokMode ? 'on' : 'off'}`);
        } catch {
          await this.pushState('Server not running');
        }
        return;
      }

      case 'restartServer': {
        this.post({ type: 'busy', busy: true, label: 'Restarting server…' });
        await this.deps.restartServer();
        await this.pushState('Server restarted');
        return;
      }

      case 'openProvidersFile': {
        const document = await vscode.workspace.openTextDocument(resolveConfigPaths().providers);
        await vscode.window.showTextDocument(document);
        return;
      }

      default:
        return;
    }
  }

  /**
   * Asks the upstream service which models it serves.
   *
   * Run here rather than in the webview because the webview has no network
   * access to arbitrary hosts, and because the API key must not leave the
   * extension host.
   */
  private async fetchModels(raw: ProviderConfig): Promise<void> {
    const provider = normaliseProvider(raw, 0);
    this.post({ type: 'busy', busy: true, label: 'Fetching models…' });

    if (!provider.authValue) {
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'notice', level: 'warn', text: 'Set an auth value before fetching models.' });
      return;
    }

    const kind = kindOfType(provider.type);
    const instance =
      kind === 'anthropic'
        ? new AnthropicProvider(provider)
        : kind === 'gemini'
          ? new GeminiProvider(provider)
          : new OpenAiProvider(provider);

    try {
      const catalog: CatalogEntry[] = await instance.listModels();
      this.deps.log(`fetched ${catalog.length} model(s) from ${provider.name}`);
      this.post({ type: 'catalog', providerId: provider.id, entries: catalog });
      this.post({
        type: 'notice',
        level: 'info',
        text: `Fetched ${catalog.length} model${catalog.length === 1 ? '' : 's'}.`,
      });
    } catch (error) {
      this.deps.log(`model fetch failed for ${provider.name}: ${(error as Error).message}`);
      this.post({ type: 'notice', level: 'error', text: `Fetch failed: ${(error as Error).message}` });
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  /** Sends the full panel state: providers, server health and schema state. */
  private async pushState(notice?: string): Promise<void> {
    const paths = resolveConfigPaths();
    const document = readProvidersDocument(paths.providers);
    const config = loadConfigFrom(paths.config).config;
    const status = await this.fetchStatus();

    this.post({
      type: 'state',
      providers: document.providers,
      providersPath: paths.providers,
      webSearch: config.webSearch,
      byokMode: status?.byokMode ?? config.byokMode,
      server: status
        ? {
            online: true,
            version: status.version,
            models: status.models,
            schemaAvailable: status.schema.available,
            schemaCursorVersion: status.schema.cursorVersion,
          }
        : { online: false },
      options: {
        types: PROVIDER_TYPES,
        thinkingLevels: THINKING_LEVELS,
        defaultBaseUrls: DEFAULT_BASE_URLS,
        // The panel needs to know which backends want a key, so it can hide
        // the field for the ones that do not.
        searchBackends: WEB_SEARCH_BACKENDS.map((id) => ({
          id,
          label: WEB_SEARCH_BACKEND_IMPLEMENTATIONS[id].label,
          requiresApiKey: WEB_SEARCH_BACKEND_IMPLEMENTATIONS[id].requiresApiKey,
        })),
      },
      ...(notice ? { notice } : {}),
    });
    this.post({ type: 'busy', busy: false });
  }

  private async fetchStatus(): Promise<ServerStatusReport | null> {
    const { server } = loadConfigFrom(resolveConfigPaths().config).config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_200);
    try {
      const response = await fetch(`http://${server.host}:${server.port}${STATUS_PATH}`, {
        signal: controller.signal,
      });
      return (await response.json()) as ServerStatusReport;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  /**
   * Builds the webview document.
   *
   * The script and stylesheet are served as webview resources under a content
   * security policy with a per-load nonce, which is the supported way to run
   * scripts in a panel without weakening the sandbox.
   */
  private render(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const body = readFileSync(join(this.extensionPath, 'media', 'panel.html'), 'utf-8');

    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      // The panel talks to the local server only.
      `connect-src http://127.0.0.1:* http://localhost:*`,
    ].join('; ');

    return body
      .replace(/__CSP__/g, csp)
      .replace(/__STYLE_URI__/g, styleUri.toString())
      .replace(/__SCRIPT_URI__/g, scriptUri.toString())
      .replace(/__NONCE__/g, nonce);
  }
}

function randomNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}

export { createModel, createProvider };
