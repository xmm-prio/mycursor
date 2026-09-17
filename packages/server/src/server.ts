/**
 * The local BYOK server.
 *
 * It listens twice, because the interception layers arrive differently. The
 * path-aware layers redirect to a plaintext port carrying both HTTP/1.1 and
 * cleartext HTTP/2; the socket-level layer cannot downgrade a connection it
 * captured before any path existed, so it arrives over TLS with the client's
 * own ALPN. Serving both is what allows the socket backstop to exist at all,
 * and the backstop is what stops a future Cursor transport from silently
 * bypassing the toolkit.
 *
 * Assembly lives here and behaviour lives in the modules below it, so the
 * wiring can be read in one screen.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createH2Server, type Http2Server } from 'node:http2';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import type { Server as NetServer } from 'node:net';

import { ConfigStore, resolveConfigPaths, saveConfigTo, type MyCursorConfig } from '@mycursor/core/config';
import { Logger } from '@mycursor/core/logging';
import { createProtocolMultiplexer, handTlsSocketByAlpn } from '@mycursor/core/net';
import { loadOrCreateCertificate } from '@mycursor/core/tls';
import { loadProvidersFrom, ProviderRegistry } from '@mycursor/providers';

import { parseContentType, unaryResponse } from '@mycursor/protocol/connect';

import { SessionRegistry } from './agent/session.js';
import { TurnRunner } from './agent/turn.js';
import { ConfigBroadcaster, ControlRoutes, type ServerStatusReport } from './control/routes.js';
import { fromHttp1, fromHttp2, type Exchange } from './listener/exchange.js';
import { OpenAiRoutes } from './openai/routes.js';
import {
  handleBidiAppend,
  handleRunSse,
  type AgentHandlerDeps,
} from './rpc/handlers/agent-run.js';
import { buildAvailableModelsResponse } from './rpc/handlers/available-models.js';
import { handleKnowledgeBase } from './rpc/handlers/knowledge-base.js';
import { KnowledgeStore } from './knowledge/store.js';
import { WebSearchToolProvider } from './websearch/provider.js';
import type { WebSearchBackendId } from './websearch/types.js';
import { Dispatcher, type DispatchOutcome, type RpcHandler } from './rpc/dispatcher.js';
import { DescriptorStore } from './schema/descriptor-store.js';
import { UpstreamProxy } from './upstream/proxy.js';

export const SERVER_VERSION = '0.1.0';

export interface ServerOptions {
  /** Overrides the configuration document path. */
  configPath?: string;
  /** Overrides the providers document path. */
  providersPath?: string;
  /** Overrides the extracted Cursor schema path. */
  descriptorsPath?: string;
  /** Overrides the knowledge base path. */
  knowledgePath?: string;
  /** Directory for the TLS material; defaults to the configuration root. */
  tlsDirectory?: string;
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
}

export interface RunningServer {
  plainPort: number;
  tlsPort: number;
  close(): Promise<void>;
  status(): ServerStatusReport;
}

export class MyCursorServer {
  private readonly logger: Logger;
  private readonly store: ConfigStore;
  private readonly broadcaster = new ConfigBroadcaster();
  private readonly sessions: SessionRegistry;
  private readonly counters = new Map<DispatchOutcome, number>();
  private readonly startedAt = Date.now();
  private readonly configPath: string;
  private readonly providersPath: string;
  private readonly tlsDirectory: string;
  private readonly descriptors: DescriptorStore;
  private readonly knowledge: KnowledgeStore;

  private providers: ProviderRegistry;
  private providerWarnings: string[] = [];
  private proxy!: UpstreamProxy;
  private runner!: TurnRunner;
  private dispatcher!: Dispatcher;
  private openai!: OpenAiRoutes;

  private plain: NetServer | null = null;
  private secure: TlsServer | null = null;
  private readonly inner: { http1: HttpServer; http2: Http2Server }[] = [];

  constructor(options: ServerOptions = {}) {
    const paths = resolveConfigPaths();
    this.configPath = options.configPath ?? paths.config;
    this.providersPath = options.providersPath ?? paths.providers;
    this.tlsDirectory = options.tlsDirectory ?? paths.root;

    this.logger = new Logger({ scope: 'server', level: options.logLevel ?? 'info' });
    this.store = ConfigStore.open({
      path: this.configPath,
      onDiagnostic: (message) => this.logger.warn(message),
    });
    this.sessions = new SessionRegistry({ logger: this.logger.child('agent') });
    this.descriptors = new DescriptorStore({
      path: options.descriptorsPath ?? paths.descriptors,
      logger: this.logger.child('schema'),
    });
    this.knowledge = new KnowledgeStore({
      path: options.knowledgePath ?? paths.knowledge,
      logger: this.logger.child('knowledge'),
    });

    const loaded = loadProvidersFrom(this.providersPath);
    this.providers = loaded;
    this.providerWarnings = loaded.warnings;
    for (const warning of loaded.warnings) this.logger.warn(`providers: ${warning}`);

    this.wire();

    // A configuration change reaches the renderer payloads through the event
    // stream, and reloads the provider document, so neither needs a restart.
    this.store.onChange((revision) => {
      this.reloadProviders();
      this.broadcaster.broadcast(revision.config);
      this.logger.info('configuration applied', {
        revision: revision.revision,
        byokMode: revision.config.byokMode,
        rules: revision.config.redirect.length,
      });
    });
    this.store.startWatching();
  }

  private config(): MyCursorConfig {
    return this.store.current().config;
  }

  private wire(): void {
    // Cursor's web search runs on its backend, so a BYOK turn loses it. The
    // replacement is additive: if the client still declares its own
    // `web_search`, the registry keeps the client's and this stands down.
    const webSearch = new WebSearchToolProvider(() => {
      const config = this.config().webSearch;
      return {
        enabled: config.enabled,
        backend: config.backend as WebSearchBackendId,
        apiKey: config.apiKey,
        maxResults: config.maxResults,
        allowFetch: config.allowFetch,
        proxyUrl: config.proxyUrl || undefined,
      };
    }, this.logger.child('websearch'));

    this.runner = new TurnRunner({
      providers: () => this.providers,
      toolPolicy: () => this.config().tools,
      serverTools: () => [webSearch],
      logger: this.logger.child('turn'),
    });

    this.openai = new OpenAiRoutes({
      providers: () => this.providers,
      runner: this.runner,
      logger: this.logger.child('openai'),
    });

    const control = new ControlRoutes(
      {
        config: () => this.config(),
        toggleByok: () => this.toggleByok(),
        status: () => this.status(),
        version: SERVER_VERSION,
      },
      this.broadcaster,
    );

    this.proxy = new UpstreamProxy({
      config: () => this.config().upstream,
      logger: this.logger.child('upstream'),
    });

    this.dispatcher = new Dispatcher({
      config: () => this.config(),
      control,
      proxy: this.proxy,
      logger: this.logger.child('rpc'),
      handlers: this.buildHandlers(),
      record: (outcome) => this.counters.set(outcome, (this.counters.get(outcome) ?? 0) + 1),
    });
  }

  /**
   * Handlers for methods answered locally.
   *
   * Deliberately sparse. Cursor's `.proto` files are not published, so a method
   * is only answered here when its wire shape is actually known; everything
   * else is either answered with an empty message or forwarded. Guessing at
   * field numbers would produce replies the client misparses, which is harder
   * to diagnose than a forwarded request.
   */
  private buildHandlers(): Map<string, RpcHandler> {
    const handlers = new Map<string, RpcHandler>();

    handlers.set('agent.v1.AgentService/UploadConversationBlobs', async ({ exchange }) => {
      // Blobs are content-addressed and opaque; accepting and discarding them
      // is correct for a local session and needs no schema.
      await exchange.body();
      return false;
    });

    // The native agent chat. Both halves share one dependency bundle so the
    // rendezvous, the tool catalogue and the model registry cannot drift.
    const agentDeps: AgentHandlerDeps = {
      registry: () => {
        this.descriptors.refreshIfChanged();
        return this.descriptors.current();
      },
      sessions: this.sessions,
      runner: this.runner,
      toolPolicy: () => this.config().tools,
      logger: this.logger.child('agent'),
      hasModels: () => this.providers.allModels().length > 0,
    };
    handlers.set('aiserver.v1.BidiService/BidiAppend', ({ exchange }) =>
      handleBidiAppend(agentDeps, exchange),
    );
    handlers.set('agent.v1.AgentService/RunSSE', ({ exchange }) =>
      handleRunSse(agentDeps, exchange),
    );

    // "Remember this" writes to the user's account upstream, which a BYOK
    // session does not have. Serving it from a local file keeps the feature
    // working instead of failing silently.
    for (const operation of ['list', 'add', 'update', 'remove'] as const) {
      const method = `aiserver.v1.AiService/KnowledgeBase${operation[0]!.toUpperCase()}${operation.slice(1)}`;
      handlers.set(method, async ({ exchange }) => {
        this.descriptors.refreshIfChanged();
        const outcome = handleKnowledgeBase({
          operation,
          descriptors: this.descriptors.current(),
          store: this.knowledge,
          requestBody: await exchange.body(),
          logger: this.logger.child('knowledge'),
        });

        if (!outcome.bytes) {
          this.logger.info('forwarding a knowledge base call', { reason: outcome.reason });
          return false;
        }
        exchange.send(unaryResponse(parseContentType(exchange.headers['content-type']), outcome.bytes));
        return true;
      });
    }

    handlers.set('aiserver.v1.AiService/AvailableModels', async ({ exchange }) => {
      this.descriptors.refreshIfChanged();

      // The official list is fetched first so local models are appended to it
      // rather than replacing it; Cursor's own models stay available.
      const upstream = await this.proxy.fetch(exchange);
      const outcome = buildAvailableModelsResponse({
        descriptors: this.descriptors.current(),
        providers: this.providers,
        upstreamResponse: upstream?.status === 200 ? upstream.body : null,
        logger: this.logger.child('models'),
      });

      if (!outcome.bytes) {
        this.logger.info('serving the official model list unchanged', { reason: outcome.reason });
        // Upstream already answered, so replay it rather than forwarding again.
        if (upstream) {
          exchange.send({ status: upstream.status, headers: upstream.headers, body: upstream.body });
          return true;
        }
        return false;
      }

      this.logger.info('model list served with local models injected', {
        local: outcome.localModels,
        upstream: outcome.upstreamModels,
      });
      exchange.send(unaryResponse(parseContentType(exchange.headers['content-type']), outcome.bytes));
      return true;
    });

    return handlers;
  }

  private reloadProviders(): void {
    const loaded = loadProvidersFrom(this.providersPath);
    this.providers = loaded;
    this.providerWarnings = loaded.warnings;
    for (const warning of loaded.warnings) this.logger.warn(`providers: ${warning}`);
  }

  private toggleByok(): boolean {
    const config = { ...this.config(), byokMode: !this.config().byokMode };
    saveConfigTo(this.configPath, config);
    // The watcher will publish the new revision and broadcast it; reloading
    // here as well keeps the response consistent with what was written.
    this.store.reload();
    return config.byokMode;
  }

  private async handle(exchange: Exchange): Promise<void> {
    try {
      if (this.openai.claims(exchange.path.split('?')[0] ?? '')) {
        await this.openai.handle(exchange);
        return;
      }
      await this.dispatcher.dispatch(exchange);
    } catch (error) {
      this.logger.error('unhandled exchange failure', {
        path: exchange.path,
        error: (error as Error).message,
      });
      try {
        exchange.sendJson(500, { error: `mycursor: ${(error as Error).message}` });
      } catch {
        exchange.destroy();
      }
    }
  }

  private buildInnerServers(): { http1: HttpServer; http2: Http2Server } {
    const http1 = createHttpServer((request, response) => {
      void this.handle(fromHttp1(request, response));
    });
    // Node routes a WebSocket upgrade to `upgrade` instead of `request`, so it
    // needs its own entry point to reach the same dispatcher.
    http1.on('upgrade', (request, socket) => {
      const policy = this.config().interception.websocketPolicy;
      this.counters.set('websocket-refused', (this.counters.get('websocket-refused') ?? 0) + 1);
      this.logger.debug('refused a WebSocket upgrade so the client falls back to SSE', {
        url: request.url,
        policy,
      });
      socket.write('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\n');
      socket.end();
    });

    const http2 = createH2Server();
    http2.on('request', (request, response) => {
      void this.handle(fromHttp2(request, response));
    });
    http2.on('sessionError', (error) => this.logger.debug('http2 session error', { error: error.message }));

    const pair = { http1, http2 };
    this.inner.push(pair);
    return pair;
  }

  async listen(): Promise<RunningServer> {
    const config = this.config();

    const plainServers = this.buildInnerServers();
    this.plain = createProtocolMultiplexer({
      ...plainServers,
      onDiagnostic: (message) => this.logger.debug(message),
    });

    const secureServers = this.buildInnerServers();
    const material = loadOrCreateCertificate(this.tlsDirectory, {
      commonName: 'mycursor local listener',
      dnsNames: ['localhost', '*.cursor.sh', 'cursor.sh', '*.cursor.test'],
      ipAddresses: ['127.0.0.1'],
    });
    this.secure = createTlsServer(
      {
        key: material.key,
        cert: material.cert,
        // The client's ALPN is forwarded untouched by the socket layer, so the
        // handshake decides the protocol and no sniffing is needed here.
        ALPNProtocols: ['h2', 'http/1.1'],
      },
      (socket) => handTlsSocketByAlpn(socket, secureServers),
    );

    const plainPort = await this.bind(this.plain, config.server.host, config.server.port, 'plaintext');
    const tlsPort = await this.bind(this.secure, config.server.host, config.server.tlsPort, 'TLS');

    this.logger.info('listening', {
      plain: `${config.server.host}:${plainPort}`,
      tls: `${config.server.host}:${tlsPort}`,
      providers: this.providers.size,
      models: this.providers.allModels().length,
      byokMode: config.byokMode,
    });

    return {
      plainPort,
      tlsPort,
      close: () => this.close(),
      status: () => this.status(),
    };
  }

  private bind(
    server: NetServer | TlsServer,
    host: string,
    port: number,
    label: string,
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('error', onError);
        if (error.code === 'EADDRINUSE') {
          // A clear message here saves a long diagnosis: the most common cause
          // is a second copy of this server already running.
          reject(
            new Error(
              `${label} port ${host}:${port} is already in use. Another mycursor server may be running; check "mycursor status".`,
            ),
          );
          return;
        }
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.removeListener('error', onError);
        const address = server.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  status(): ServerStatusReport {
    const config = this.config();
    const plain = this.plain?.address();
    const secure = this.secure?.address();
    return {
      version: SERVER_VERSION,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      byokMode: config.byokMode,
      listeners: {
        plain: typeof plain === 'object' && plain ? plain.port : null,
        tls: typeof secure === 'object' && secure ? secure.port : null,
      },
      providers: this.providers.list().map((provider) => ({
        id: provider.id,
        kind: provider.kind,
        models: provider.models.length,
      })),
      models: this.providers.allModels().length,
      routeRules: config.redirect.length,
      schema: {
        available: this.descriptors.available,
        cursorVersion: this.descriptors.cursorVersion,
        messages: this.descriptors.current().stats().messages,
        methods: this.descriptors.current().methodCount,
      },
      counters: Object.fromEntries(this.counters),
      warnings: [...this.providerWarnings, ...this.store.current().warnings],
    };
  }

  async close(): Promise<void> {
    this.sessions.dispose();
    this.store.close();
    const closers: Promise<void>[] = [];
    for (const server of [this.plain, this.secure]) {
      if (!server) continue;
      closers.push(new Promise((resolve) => server.close(() => resolve())));
    }
    for (const pair of this.inner) {
      pair.http1.closeAllConnections?.();
      pair.http1.close();
      pair.http2.close();
    }
    await Promise.all(closers);
    this.logger.info('stopped');
  }
}
