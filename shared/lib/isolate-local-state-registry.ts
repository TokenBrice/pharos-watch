export type IsolateLocalStateKind = "cache" | "counter" | "key" | "limiter" | "coordination";

export interface IsolateLocalStateRegistryEntry {
  sourcePath: string;
  stateNames: readonly string[];
  owner: string;
  kind: IsolateLocalStateKind;
  resetOrTtl: string;
  durableTruth: string;
}

/**
 * Mutable module state that can survive more than one request in a Worker or
 * Pages Functions isolate. Keep this list complete: durable correctness must
 * never depend on an entry here because isolates are independent and recycled.
 */
export const ISOLATE_LOCAL_STATE_REGISTRY = [
  {
    sourcePath: "functions/lib/client-ip-hash.ts",
    stateNames: ["cachedSecret", "cachedKey"],
    owner: "Pages client-IP hashing",
    kind: "key",
    resetOrTtl: "Replaced when the supplied secret changes; otherwise resets on isolate recycle or deploy.",
    durableTruth: "The runtime secret is authoritative; the non-extractable imported key is only a derived cache.",
  },
  {
    sourcePath: "functions/lib/request-attribution.ts",
    stateNames: ["siteDataRequestRecorder"],
    owner: "Pages site-data attribution",
    kind: "coordination",
    resetOrTtl: "Batches up to 50 entries after a 10ms delay; prune coordination is hourly and all state resets with the isolate.",
    durableTruth: "D1 site_data_request_stats rows are authoritative.",
  },
  {
    sourcePath: "functions/selector-snapshot/[[path]].ts",
    stateNames: ["postTimestampsByIpHash"],
    owner: "Selector snapshot POST limiter",
    kind: "limiter",
    resetOrTtl: "60-second sliding window, 10 requests per IP hash, capped at 5,000 tracked hashes; resets with the isolate.",
    durableTruth: "The D1 daily quota reservation is authoritative; this is a best-effort local throttle.",
  },
  {
    sourcePath: "shared/lib/cloudflare-access-jwt.ts",
    stateNames: ["jwksCache"],
    owner: "Cloudflare Access JWT verification",
    kind: "cache",
    resetOrTtl: "One-hour TTL per Access team domain; resets with the isolate.",
    durableTruth: "The Cloudflare Access JWKS endpoint and each presented JWT remain authoritative.",
  },
  {
    sourcePath: "shared/lib/format.ts",
    stateNames: ["decimalFormatterCache"],
    owner: "Shared decimal formatting",
    kind: "cache",
    resetOrTtl: "One Intl.NumberFormat per requested digit-range pair until isolate recycle.",
    durableTruth: "Formatting inputs and locale options are authoritative; cached formatters carry no business state.",
  },
  {
    sourcePath: "shared/lib/safety-score-v9/compile.ts",
    stateNames: ["validatedCompiledFactSets"],
    owner: "Safety Score V9 fact compilation",
    kind: "cache",
    resetOrTtl: "Weak object-identity marker; entries are garbage-collectable and disappear on isolate recycle.",
    durableTruth: "Validated fact-set input and its digest are authoritative; the marker only proves local compilation.",
  },
  {
    sourcePath: "shared/lib/safety-score-v9/policy.ts",
    stateNames: ["validatedPolicyEnvelopes"],
    owner: "Safety Score V9 policy validation",
    kind: "cache",
    resetOrTtl: "Weak object-identity marker; entries are garbage-collectable and disappear on isolate recycle.",
    durableTruth: "The validated policy envelope and digest are authoritative; the marker only proves local validation.",
  },
  {
    sourcePath: "worker/src/api/og.tsx",
    stateNames: ["wasmInitialization"],
    owner: "OG-image WASM initialization",
    kind: "coordination",
    resetOrTtl: "One shared initialization promise per isolate; cleared after an initialization failure or isolate recycle.",
    durableTruth: "The bundled WASM modules are authoritative; the promise only coalesces initialization work.",
  },
  {
    sourcePath: "worker/src/api/stablecoin-detail.ts",
    stateNames: ["detailRefreshesInFlight"],
    owner: "Stablecoin-detail refresh",
    kind: "coordination",
    resetOrTtl: "One promise per detail cache key until it settles, then deleted; resets with the isolate.",
    durableTruth: "D1 detail cache rows and circuit-breaker state are authoritative across isolates.",
  },
  {
    sourcePath: "worker/src/cron/depeg-resolver/utils.ts",
    stateNames: [
      "v9DependencyImpairmentByCoin",
      "v9MintPostureBandByCoin",
      "v9MintPostureProjectionInstalled",
    ],
    owner: "Depeg resolver V9 dependency and mint-posture projection",
    kind: "cache",
    resetOrTtl: "All three hydrated from the current V9 cards at resolver-run start; cleared when V9 publication is unavailable and reset with the isolate. The installed flag distinguishes a published 'no band' from an absent publication so K1 can fall back to the curated posture instead of failing open.",
    durableTruth: "The current Safety Score V9 publication inputs and stablecoin registry statuses are authoritative; this only avoids repeated per-coin dependency and mint-component scans inside one run.",
  },
  {
    sourcePath: "worker/src/cron/dex-discovery/crawl-horizon-pools.ts",
    stateNames: ["horizonRequestState"],
    owner: "Stellar Horizon discovery pacing",
    kind: "coordination",
    resetOrTtl: "One last-request timestamp enforcing the ~1s Horizon pacing floor inside a single discovery run; resets with the isolate and via the test-only reset hook.",
    durableTruth: "Horizon's server-side rate limit is authoritative; this state only spaces requests within one isolate to stay under it.",
  },
  {
    sourcePath: "worker/src/lib/telegram-quiet-hours.ts",
    stateNames: ["quietHoursTzFallbackLastLoggedAt"],
    owner: "Telegram quiet-hours telemetry",
    kind: "cache",
    resetOrTtl: "One fallback-log timestamp per timezone with a one-hour suppression window; resets with the isolate.",
    durableTruth: "Runtime timezone resolution is authoritative; this state only suppresses duplicate logs.",
  },
  {
    sourcePath: "worker/src/handlers/http/gates.ts",
    stateNames: ["LOGGED_ENV_ISSUES"],
    owner: "Worker environment validation",
    kind: "cache",
    resetOrTtl: "One logged entry per finite environment-contract issue code until isolate recycle.",
    durableTruth: "The current Env bindings and validateWorkerEnvContract() result are authoritative.",
  },
  {
    sourcePath: "worker/src/lib/api-cache-read.ts",
    stateNames: ["_cacheRead"],
    owner: "Persisted-cache JSON diagnostics",
    kind: "counter",
    resetOrTtl: "At most 256 LRU parse-failure contexts; resets with the isolate.",
    durableTruth: "The D1 cache payload is authoritative; counters are diagnostic only.",
  },
  {
    sourcePath: "worker/src/lib/api-key-core.ts",
    stateNames: ["_ak"],
    owner: "API-key authentication and fallback limiting",
    kind: "cache",
    resetOrTtl: "Key lookups are fresh for 5 seconds (2,048 entries); usage and fallback limiter maps cap at 4,096 entries, with prune and dependency-circuit coordination resetting with the isolate.",
    durableTruth: "D1 API-key, rate-limit, and last-used rows are authoritative; local fallback limiting is emergency-only.",
  },
  {
    sourcePath: "worker/src/lib/auth.ts",
    stateNames: ["timingSafeCompareKeyPromise"],
    owner: "Timing-safe comparison",
    kind: "key",
    resetOrTtl: "One non-extractable HMAC key per isolate, regenerated after isolate recycle.",
    durableTruth: "The compared request values remain authoritative; the key is only a local comparison primitive.",
  },
  {
    sourcePath: "worker/src/lib/circuit-breaker.ts",
    stateNames: ["circuitRecordCacheByDb"],
    owner: "Provider circuit breaker",
    kind: "cache",
    resetOrTtl: "Weakly keyed by D1 binding; records have a 5-second memo TTL and reset with the isolate.",
    durableTruth: "D1 cache circuit records are authoritative.",
  },
  {
    sourcePath: "worker/src/lib/cron-logger.ts",
    stateNames: ["cronFailureCounts"],
    owner: "Cron failure logging",
    kind: "counter",
    resetOrTtl: "One in-memory count per job until isolate recycle.",
    durableTruth: "cron_runs and durable cron-event records are authoritative; counts only tune log severity.",
  },
  {
    sourcePath: "worker/src/lib/fx-rate-state.ts",
    stateNames: ["_fxCalendar"],
    owner: "FX business-day calendar",
    kind: "cache",
    resetOrTtl: "Caches computed closing-day sets by year until isolate recycle.",
    durableTruth: "Deterministic calendar rules and current FX cache rows are authoritative.",
  },
  {
    sourcePath: "worker/src/lib/rate-limit.ts",
    stateNames: ["_rl"],
    owner: "Feedback rate-limit cleanup",
    kind: "coordination",
    resetOrTtl: "Tracks one pending prune promise and consecutive prune failures until completion or isolate recycle.",
    durableTruth: "Atomic D1 feedback_rate_limit reservations are authoritative.",
  },
  {
    sourcePath: "worker/src/lib/request-source-attribution.ts",
    stateNames: ["workerRequestRecorder", "apiKeyRequestRecorder"],
    owner: "Worker request attribution",
    kind: "coordination",
    resetOrTtl: "Each recorder batches up to 50 entries after a 10ms delay; prune coordination is hourly and all state resets with the isolate.",
    durableTruth: "D1 api_request_consumer_stats and api_key_request_stats rows are authoritative.",
  },
  {
    sourcePath: "worker/src/lib/safety-score-v9-fact-set.ts",
    stateNames: ["materializedExtensions"],
    owner: "Safety Score V9 extension materialization",
    kind: "cache",
    resetOrTtl: "Weak object-identity marker; entries are garbage-collectable and disappear on isolate recycle.",
    durableTruth: "Schema-validated extension input is authoritative; the marker only records local materialization.",
  },
  {
    sourcePath: "worker/src/lib/status-reliability-shared.ts",
    stateNames: ["LOGGED_STATUS_PERSISTENCE_FAILURES"],
    owner: "Status persistence logging",
    kind: "cache",
    resetOrTtl: "Capped at 200 code-operation keys and resets with the isolate.",
    durableTruth: "D1 status state, transitions, and probe rows are authoritative; this is log-noise suppression only.",
  },
  {
    sourcePath: "worker/src/lib/telegram-log.ts",
    stateNames: [
      "invalidSecretWindowStartedAt",
      "invalidSecretWindowCount",
      "missingSecretWindowStartedAt",
      "missingSecretWindowCount",
    ],
    owner: "Telegram webhook secret telemetry",
    kind: "counter",
    resetOrTtl: "Two secret-attempt windows reset after SECRET_AUTH_SPIKE_WINDOW_MS or isolate recycle.",
    durableTruth: "Webhook authentication is evaluated from current request and Env secrets; counters only sample logs.",
  },
  {
    sourcePath: "worker/src/cron/reserve-adapters/request.ts",
    stateNames: ["requestCacheStates"],
    owner: "Live-reserve adapter request cache",
    kind: "cache",
    resetOrTtl: "WeakMap keyed by each run's requestCache Map; LRU byte accounting lives only as long as the run's cache object and resets with the isolate.",
    durableTruth: "Issuer endpoints are authoritative; cached bodies are per-run fetch dedup only, bounded to a 16 MiB budget.",
  },
  {
    sourcePath: "worker/src/lib/chain-registry.ts",
    stateNames: ["ALCHEMY_AUTHORIZATION_BY_URL"],
    owner: "Alchemy RPC bearer-auth routing",
    kind: "key",
    resetOrTtl: "Repopulated on every buildAlchemyRpcUrl call for the configured key; resets with the isolate.",
    durableTruth: "Env ALCHEMY_API_KEY is authoritative; the map only pairs key-free URLs with their Authorization header.",
  },
  {
    sourcePath: "worker/src/lib/telegram-mini-app-auth.ts",
    stateNames: ["warnedNovelMiniAppChatTypes"],
    owner: "Telegram Mini App auth telemetry",
    kind: "cache",
    resetOrTtl: "One warning per novel chat_type until isolate recycle.",
    durableTruth: "Signed Telegram initData and current request fields are authoritative; this only suppresses duplicate logs.",
  },
] as const satisfies readonly IsolateLocalStateRegistryEntry[];

export const ISOLATE_LOCAL_STATE_DOC_START = "<!-- ISOLATE-LOCAL-STATE:START -->";
export const ISOLATE_LOCAL_STATE_DOC_END = "<!-- ISOLATE-LOCAL-STATE:END -->";

function code(value: string): string {
  return `\`${value}\``;
}

export function renderIsolateLocalStateDocumentation(): string {
  const rows = ISOLATE_LOCAL_STATE_REGISTRY.map((entry) =>
    `| ${code(entry.sourcePath)} | ${entry.stateNames.map(code).join("<br>")} | ${entry.owner} | ${entry.resetOrTtl} | ${entry.durableTruth} |`,
  );

  return [
    ISOLATE_LOCAL_STATE_DOC_START,
    "This generated inventory covers mutable module state that can survive more than one request in a Worker or Pages Functions isolate. The registry is `shared/lib/isolate-local-state-registry.ts`; its completeness test rejects new unregistered state.",
    "",
    "| Source | State | Owner | TTL / reset semantics | Durable truth |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "All entries are isolate-local: they are not shared across isolates and reset on a cold start, deployment, or isolate recycle. They are optimization, local-coordination, or diagnostic aids only; durable correctness must come from D1, request inputs, configured bindings, or upstream provider responses.",
    ISOLATE_LOCAL_STATE_DOC_END,
  ].join("\n");
}
