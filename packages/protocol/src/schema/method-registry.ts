/**
 * What is known about Cursor's RPC methods.
 *
 * Cursor's `.proto` files are not published, so this registry records only what
 * can be established from observed traffic and does not pretend to more. Two
 * facts per method are enough for the server to behave correctly:
 *
 *  - the *cardinality*, because a server-streaming method must not be answered
 *    with a unary body, and a client-streaming method must not be answered
 *    before its messages arrive;
 *  - the *handling strategy*, which says whether the local server can answer
 *    the method itself or should forward it upstream.
 *
 * Message field numbers are deliberately absent. Anything that needs them uses
 * the structural codec, and the recorder in `wire/introspect` is how a new
 * descriptor gets written from real traffic rather than from guesswork.
 */

export type MethodCardinality = 'unary' | 'server-stream' | 'client-stream' | 'bidi';

export type HandlingStrategy =
  /** The local server produces the whole response. */
  | 'local'
  /**
   * The local server answers with an empty message.
   *
   * Protobuf gives every field a default, so an empty message is a valid
   * encoding of any type. That makes it the correct answer for the account and
   * dashboard endpoints a BYOK session has no real data for — the client gets a
   * well-formed reply and no field number has to be invented.
   */
  | 'empty'
  /** Forward to the official API unchanged. */
  | 'upstream';

export interface MethodInfo {
  service: string;
  method: string;
  cardinality: MethodCardinality;
  strategy: HandlingStrategy;
  /** Why this method is handled the way it is. */
  note?: string;
}

function method(
  qualified: string,
  cardinality: MethodCardinality,
  strategy: HandlingStrategy,
  note?: string,
): [string, MethodInfo] {
  const slash = qualified.indexOf('/');
  return [
    qualified,
    {
      service: qualified.slice(0, slash),
      method: qualified.slice(slash + 1),
      cardinality,
      strategy,
      ...(note ? { note } : {}),
    },
  ];
}

/**
 * Methods whose behaviour is established. Everything absent from this table is
 * treated as unary and forwarded upstream, which is the safe default: an
 * unknown method keeps working exactly as it does without the toolkit.
 */
const METHODS = new Map<string, MethodInfo>([
  // Model traffic: the reason the toolkit exists.
  method(
    'aiserver.v1.AiService/AvailableModels',
    'unary',
    'local',
    'answered from the local model catalogue',
  ),
  method('agent.v1.AgentService/RunSSE', 'server-stream', 'local', 'the agent turn loop'),
  method(
    'aiserver.v1.BidiService/BidiAppend',
    'client-stream',
    'local',
    'carries the run request that RunSSE waits for',
  ),
  method(
    'agent.v1.AgentService/UploadConversationBlobs',
    'unary',
    'local',
    'conversation blobs are stored locally',
  ),

  // Summaries, persisted alongside the local session.
  method('aiserver.v1.ChatService/GetConversationSummary', 'unary', 'local'),
  method('aiserver.v1.ChatService/StreamSpeculativeSummaries', 'server-stream', 'local'),

  // Knowledge base, persisted locally.
  method('aiserver.v1.AiService/KnowledgeBaseList', 'unary', 'local'),
  method('aiserver.v1.AiService/KnowledgeBaseAdd', 'unary', 'local'),
  method('aiserver.v1.AiService/KnowledgeBaseUpdate', 'unary', 'local'),
  method('aiserver.v1.AiService/KnowledgeBaseRemove', 'unary', 'local'),

  // Model and server configuration discovery.
  method('aiserver.v1.AiService/ServerTime', 'unary', 'local'),
  method('aiserver.v1.AiService/GetDefaultModel', 'unary', 'local'),
  method('aiserver.v1.AiService/GetDefaultModelNudgeData', 'unary', 'empty'),

  // Account state a BYOK session has no upstream answer for.
  method('aiserver.v1.AnalyticsService/Batch', 'unary', 'empty', 'telemetry is dropped locally'),
  method('aiserver.v1.DashboardService/GetPlanInfo', 'unary', 'local'),
  method('aiserver.v1.DashboardService/GetCurrentPeriodUsage', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetTeams', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetUserPrivacyMode', 'unary', 'local'),
  method('aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetEffectiveUserPlugins', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/IsOnNewPricing', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetManagedSkills', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetTeamAdminSettings', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetTeamBackgroundAgentSettings', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetTeamRepos', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetGlobalCommands', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetTeamCommands', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/GetSlackInstallUrl', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/ShareCanvas', 'unary', 'empty'),
  method('aiserver.v1.DashboardService/LookupSharedCanvasByKey', 'unary', 'empty'),

  // Background composer polling, which otherwise spins against 401s.
  method('aiserver.v1.BackgroundComposerService/ListBackgroundComposers', 'unary', 'empty'),
  method('aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings', 'unary', 'empty'),
  method('aiserver.v1.BackgroundComposerService/ListTeamEnvironments', 'unary', 'empty'),
  method('aiserver.v1.BackgroundComposerService/ListPersonalEnvironments', 'unary', 'empty'),
]);

/**
 * Services answered with an empty message for every method.
 *
 * `AnalyticsService` is absent on purpose: only its `Batch` method is claimed,
 * so `BootstrapStatsig` still reaches the official API and Cursor's feature
 * gates — and with them its native tool surface — keep working.
 */
const EMPTY_SERVICES = new Set([
  'aiserver.v1.AuthService',
  'aiserver.v1.ServerConfigService',
  'aiserver.v1.NetworkService',
  'aiserver.v1.HealthService',
  'aiserver.v1.InAppAdService',
]);

export function lookupMethod(service: string, methodName: string): MethodInfo {
  const exact = METHODS.get(`${service}/${methodName}`);
  if (exact) return exact;

  if (EMPTY_SERVICES.has(service)) {
    return {
      service,
      method: methodName,
      cardinality: 'unary',
      strategy: 'empty',
      note: 'service is stubbed wholesale for BYOK sessions',
    };
  }

  return {
    service,
    method: methodName,
    cardinality: 'unary',
    strategy: 'upstream',
    note: 'not recognised; forwarded so native behaviour is preserved',
  };
}

/** Every method with established behaviour, for `doctor` output. */
export function knownMethods(): MethodInfo[] {
  return [...METHODS.values()];
}

export function emptyServices(): string[] {
  return [...EMPTY_SERVICES];
}
