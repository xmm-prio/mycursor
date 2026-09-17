/**
 * Default configuration document and the route groups it is assembled from.
 *
 * Route rules are grouped by intent rather than listed flat, so a reader can
 * tell why a rule exists and an operator can enable or disable a whole concern
 * from one place.
 */

import type { MyCursorConfig } from './types.js';

export const CONFIG_SCHEMA_VERSION = 1;

export const CONFIG_DIR_NAME = '.mycursor';
export const CONFIG_FILE_NAME = 'config.json';
export const PROVIDERS_FILE_NAME = 'providers.json';
export const MODELS_CATALOG_FILE_NAME = 'models-catalog.json';
export const DESCRIPTORS_FILE_NAME = 'cursor-descriptors.json';
export const KNOWLEDGE_FILE_NAME = 'knowledge-base.json';
export const STATE_DB_FILE_NAME = 'state.json';

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_SERVER_PORT = 39841;
export const DEFAULT_SERVER_TLS_PORT = 39842;
export const DEFAULT_COLLECTOR_PORT = 14810;
export const DEFAULT_TUNNEL_PORT = 39841;
export const DEFAULT_TUNNEL_TLS_PORT = 39842;

/**
 * Hosts Cursor uses for its control plane and model traffic. Kept as regex
 * sources so the list travels through JSON configuration unchanged.
 */
export const DEFAULT_HOST_PATTERNS: readonly string[] = [
  '^(.+\\.)?api[2-9]\\.cursor\\.sh$',
  '^(.+\\.)?gcpp\\.cursor\\.sh$',
  '^api\\.playground\\.cursor\\.sh$',
  '^(.+\\.)?api\\.cursor\\.sh$',
];

/**
 * Account and billing REST endpoints. Required even with BYOK disabled so the
 * client renders a usable account state instead of retrying forever.
 */
export const ACCOUNT_ROUTES: readonly string[] = [
  'REST:/auth/full_stripe_profile',
  'REST:/auth/stripe_profile',
];

/** Endpoints that carry model traffic — the core of BYOK. */
export const MODEL_TRAFFIC_ROUTES: readonly string[] = [
  'aiserver.v1.AiService/AvailableModels',
  'agent.v1.AgentService/RunSSE',
  'agent.v1.AgentService/UploadConversationBlobs',
  'aiserver.v1.BidiService/BidiAppend',
];

/**
 * The agent WebSocket upgrade path.
 *
 * Claiming it as an ordinary route rule is what lets the toolkit decide the
 * WebSocket question at runtime — serve the upgrade, or refuse it so the client
 * falls back to its SSE transport. The reference implementation instead edits
 * Cursor's minified bundle to make the WebSocket branch unreachable, which has
 * to be re-derived for every release.
 */
export const AGENT_TRANSPORT_ROUTES: readonly string[] = ['REST:/agent/v1/run'];

/**
 * The knowledge base behind Cursor's "remember this".
 *
 * Upstream these write to the user's account, which a BYOK session does not
 * have, so forwarding them fails silently: the add reports success and the
 * list comes back empty. They are answered from a local file instead.
 */
export const KNOWLEDGE_ROUTES: readonly string[] = [
  'aiserver.v1.AiService/KnowledgeBaseList',
  'aiserver.v1.AiService/KnowledgeBaseAdd',
  'aiserver.v1.AiService/KnowledgeBaseUpdate',
  'aiserver.v1.AiService/KnowledgeBaseRemove',
];

/** Model/config discovery endpoints answered from the local catalogue. */
export const MODEL_CONFIG_ROUTES: readonly string[] = [
  'aiserver.v1.AiService/ServerTime',
  'aiserver.v1.AiService/GetDefaultModel',
  'aiserver.v1.AiService/GetDefaultModelNudgeData',
];

/**
 * Services stubbed wholesale because a BYOK session has no upstream account.
 *
 * `BootstrapStatsig` is deliberately absent: it stays on the official API so
 * feature gates — and therefore Cursor's native tool surface — keep working.
 */
export const ACCOUNT_STUB_ROUTES: readonly string[] = [
  'aiserver.v1.AuthService',
  'aiserver.v1.ServerConfigService',
  'aiserver.v1.NetworkService',
  'aiserver.v1.HealthService',
  'aiserver.v1.InAppAdService',
  'aiserver.v1.AnalyticsService/Batch',
  'REST:/auth/has_valid_payment_method',
  'REST:/auth/poll',
  'REST:/auth/logout',
];

/**
 * Dashboard endpoints stubbed per method. Methods that are not listed fall
 * through to the official API, which keeps marketplace and plugin discovery
 * intact.
 */
export const DASHBOARD_STUB_ROUTES: readonly string[] = [
  'aiserver.v1.DashboardService/GetPlanInfo',
  'aiserver.v1.DashboardService/GetCurrentPeriodUsage',
  'aiserver.v1.DashboardService/GetTeams',
  'aiserver.v1.DashboardService/GetUserPrivacyMode',
  'aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants',
  'aiserver.v1.DashboardService/GetEffectiveUserPlugins',
  'aiserver.v1.DashboardService/IsOnNewPricing',
  'aiserver.v1.DashboardService/GetManagedSkills',
  'aiserver.v1.DashboardService/GetTeamAdminSettings',
  'aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam',
  'aiserver.v1.DashboardService/GetTeamBackgroundAgentSettings',
  'aiserver.v1.DashboardService/GetTeamRepos',
  'aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam',
  'aiserver.v1.DashboardService/GetGlobalCommands',
  'aiserver.v1.DashboardService/GetTeamCommands',
  'aiserver.v1.DashboardService/GetSlackInstallUrl',
  'aiserver.v1.DashboardService/ShareCanvas',
  'aiserver.v1.DashboardService/LookupSharedCanvasByKey',
];

/** Background composer polling that would otherwise spin against 401s. */
export const BACKGROUND_ROUTES: readonly string[] = [
  'aiserver.v1.BackgroundComposerService/ListBackgroundComposers',
  'aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings',
  'aiserver.v1.BackgroundComposerService/ListTeamEnvironments',
  'aiserver.v1.BackgroundComposerService/ListPersonalEnvironments',
];

/** Rules applied whenever the toolkit is installed, regardless of BYOK mode. */
export const BASE_ROUTES: readonly string[] = [...ACCOUNT_ROUTES];

/** Rules applied on top of {@link BASE_ROUTES} when BYOK mode is on. */
export const BYOK_ROUTES: readonly string[] = [
  ...MODEL_TRAFFIC_ROUTES,
  ...AGENT_TRANSPORT_ROUTES,
  ...KNOWLEDGE_ROUTES,
  ...MODEL_CONFIG_ROUTES,
  ...ACCOUNT_STUB_ROUTES,
  ...DASHBOARD_STUB_ROUTES,
  ...BACKGROUND_ROUTES,
];

export const DEFAULT_ROUTES: readonly string[] = [...BASE_ROUTES, ...BYOK_ROUTES];

export function createDefaultConfig(): MyCursorConfig {
  return {
    $schemaVersion: CONFIG_SCHEMA_VERSION,
    byokMode: true,
    server: {
      host: DEFAULT_HOST,
      port: DEFAULT_SERVER_PORT,
      tlsPort: DEFAULT_SERVER_TLS_PORT,
    },
    collector: { host: DEFAULT_HOST, port: DEFAULT_COLLECTOR_PORT },
    uplink: {
      mode: 'auto',
      tunnel: {
        host: DEFAULT_HOST,
        port: DEFAULT_TUNNEL_PORT,
        tlsPort: DEFAULT_TUNNEL_TLS_PORT,
      },
      probeTtlSeconds: 30,
      probeTimeoutMs: 400,
    },
    interception: {
      layers: {
        http1: true,
        http2: true,
        fetch: true,
        socket: true,
        websocket: true,
        dns: false,
      },
      readiness: {
        strategy: 'hold',
        maxWaitMs: 20_000,
        retryDelayMs: 250,
        cacheTtlSeconds: 10,
      },
      websocketPolicy: 'downgrade',
      hostPatterns: [...DEFAULT_HOST_PATTERNS],
      verbose: false,
    },
    upstream: {
      policy: 'proxy',
      port: 443,
      timeoutMs: 120_000,
      retries: 1,
    },
    tools: {
      preserveNative: true,
      allowAugmentation: true,
      augmentationDenyList: [],
      nativeAllowList: [],
    },
    webSearch: {
      // Off by default: it sends the user's queries to a third party, which
      // should be a decision rather than something that starts happening.
      enabled: false,
      backend: 'duckduckgo',
      apiKey: '',
      maxResults: 5,
      allowFetch: true,
      proxyUrl: '',
    },
    redirect: [...DEFAULT_ROUTES],
  };
}
