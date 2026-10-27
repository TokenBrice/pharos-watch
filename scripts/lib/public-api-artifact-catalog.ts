import { type EndpointKey } from "@shared/lib/api-endpoints/definitions";
import { BLACKLIST_STABLECOINS } from "@shared/types/market";
import { PEG_COVERAGE_COMPOSITE_MIN } from "@shared/lib/chains/health";
import { definePublicArtifact, type PublicArtifactInput } from "./public-api-artifact-catalog-builders";
import type { PublicApiResponseSchemaName } from "./public-api-response-schemas";

export { OPENAPI_JSON_VALUE_ENDPOINT_KEYS } from "./public-api-artifact-catalog-builders";

export type QueryParamType = "string" | "integer" | "number" | "boolean";

export interface PublicApiArtifactParameter {
  name: string;
  in: "path" | "query";
  required?: boolean;
  schema: { type: QueryParamType; enum?: string[]; minimum?: number; maximum?: number; minLength?: number; maxLength?: number };
  description: string;
}

export interface PublicApiArtifactEndpoint {
  key: string;
  path: string;
  summary: string;
  description: string;
  tags: readonly string[];
  security?: "apiKey" | "none";
  responseSchema?: PublicApiResponseSchemaName;
  /**
   * Extra 200-response contracts for endpoints whose query parameters select a
   * different body shape. Emitted as `oneOf` alongside `responseSchema` so a
   * spec-validating client accepts every documented variant.
   */
  additionalResponseSchemas?: readonly PublicApiResponseSchemaName[];
  parameters?: readonly PublicApiArtifactParameter[];
  postman?: PostmanRequestConfig | readonly PostmanRequestConfig[];
}

export interface PostmanRequestConfig {
  folder: PostmanFolderName;
  order?: number;
  name?: string;
  path?: string;
  description?: string;
  query?: Record<string, string>;
  noAuth?: boolean;
}

interface PostmanStaticRequest {
  name: string;
  path: string;
  description: string;
  noAuth: true;
  base: "site";
}

export type PostmanFolderName =
  | "Getting started"
  | "Risk and market structure"
  | "Flows, blacklist, yield, and chains"
  | "Status"
  | "Historical data"
  | "Static datasets";

export const PUBLIC_API_ARTIFACT_TAGS = [
  "Health",
  "Stablecoins",
  "Peg Monitoring",
  "Liquidity",
  "Risk",
  "Blacklist",
  "Flows",
  "Yield",
  "Chains",
  "Market Structure",
  "History",
  "Digest",
  "Status",
  "Reserves",
] as const;

export const POSTMAN_FOLDERS: readonly { name: PostmanFolderName; description: string }[] = [
  {
    name: "Getting started",
    description: "Basic canaries and high-level market reads.",
  },
  {
    name: "Risk and market structure",
    description: "Stablecoin risk, peg, liquidity, flow, and dependency data.",
  },
  {
    name: "Flows, blacklist, yield, and chains",
    description: "Operational and market-structure surfaces beyond price and peg data.",
  },
  {
    name: "Status",
    description: "Public operational status surfaces.",
  },
  {
    name: "Historical data",
    description: "Per-asset and archive endpoints that should be polled less frequently.",
  },
  {
    name: "Static datasets",
    description: "Website-hosted public datasets. These do not require a Pharos API key.",
  },
] as const;

export const STABLECOIN_ID_PARAM = {
  name: "stablecoinId",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Canonical Pharos stablecoin ID, for example `usdt-tether` or `usdc-circle`.",
} as const satisfies PublicApiArtifactParameter;

export const STABLECOIN_QUERY_PARAM = {
  name: "stablecoin",
  in: "query",
  schema: { type: "string" },
  description: "Optional canonical Pharos stablecoin ID filter.",
} as const satisfies PublicApiArtifactParameter;
export const CHAIN_QUERY_PARAM = {
  name: "chain",
  in: "query",
  schema: { type: "string" },
  description: "Optional canonical Pharos chain ID for full per-chain coin detail rows.",
} as const satisfies PublicApiArtifactParameter;


export const REQUIRED_STABLECOIN_QUERY_PARAM = {
  name: "stablecoin",
  in: "query",
  required: true,
  schema: { type: "string" },
  description: "Required canonical Pharos stablecoin ID.",
} as const satisfies PublicApiArtifactParameter;

export const BLACKLIST_STABLECOIN_SYMBOL_QUERY_PARAM = {
  name: "stablecoin",
  in: "query",
  schema: { type: "string", enum: [...BLACKLIST_STABLECOINS] },
  description: "Optional uppercase blacklist-tracker stablecoin symbol filter, for example `USDT` or `USDC`.",
} as const satisfies PublicApiArtifactParameter;

export const DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1 },
  description: "Historical lookback window in days. Endpoint-specific bounds may apply.",
} as const satisfies PublicApiArtifactParameter;

export const DEX_LIQUIDITY_HISTORY_DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 365 },
  description: "Historical lookback window in days. Defaults to 90.",
} as const satisfies PublicApiArtifactParameter;

export const SUPPLY_HISTORY_DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 5000 },
  description: "Historical lookback window in days. Defaults to 365 when range is absent. Mutually exclusive with range=all.",
} as const satisfies PublicApiArtifactParameter;

export const SUPPLY_HISTORY_RANGE_PARAM = {
  name: "range",
  in: "query",
  schema: { type: "string", enum: ["all"] },
  description: "Return every retained daily row for the admitted stablecoin, under the completed-snapshot fence, without a sliding day cutoff. Omit days when using range=all; empty or other range values are rejected.",
} as const satisfies PublicApiArtifactParameter;

export const NON_USD_SHARE_DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 30, maximum: 5000 },
  description: "Historical lookback window in days. Defaults to 5000; `0` maps to the default.",
} as const satisfies PublicApiArtifactParameter;

export const SAFETY_SCORE_HISTORY_DAYS_PARAM = {
  name: "days",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 3650 },
  description: "Historical lookback window in days. Defaults to 365.",
} as const satisfies PublicApiArtifactParameter;

export const YIELD_HISTORY_MODE_PARAM = {
  name: "mode",
  in: "query",
  schema: { type: "string", enum: ["best", "source"] },
  description: "History mode. `best` returns historically selected best-source rows; `source` requires `sourceKey`.",
} as const satisfies PublicApiArtifactParameter;

export const HOURS_PARAM = {
  name: "hours",
  in: "query",
  schema: { type: "integer", minimum: 1, maximum: 720 },
  description: "Historical lookback window in hours. Defaults to 24.",
} as const satisfies PublicApiArtifactParameter;

export const LIMIT_PARAM = {
  name: "limit",
  in: "query",
  schema: { type: "integer", minimum: 1 },
  description: "Maximum number of records to return.",
} as const satisfies PublicApiArtifactParameter;

const OFFSET_QUERY_PARAM = {
  name: "offset",
  in: "query",
  schema: { type: "integer", minimum: 0 },
  description: "Pagination offset. Defaults to 0.",
} as const satisfies PublicApiArtifactParameter;

const INCLUDE_TOTAL_QUERY_PARAM = {
  name: "includeTotal",
  in: "query",
  schema: { type: "boolean" },
  description: "When false, skips the exact total count.",
} as const satisfies PublicApiArtifactParameter;

const CURSOR_QUERY_PARAM = {
  name: "cursor",
  in: "query",
  schema: { type: "string" },
  description: "Opaque keyset cursor returned as nextCursor.",
} as const satisfies PublicApiArtifactParameter;

const DATE_PATH_PARAM = {
  name: "date",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "ISO 8601 date (YYYY-MM-DD) matching a row in the snapshot index.",
} as const satisfies PublicApiArtifactParameter;

const PUBLIC_API_ARTIFACT_INPUTS = [
  {
    key: "health",
    summary: "Health check",
    description: "No-key availability canary for the public API host; it is not the operator status dashboard. Since 2026-09-27 dedicated asset-scoped circuit outages no longer count as source-wide degradation; the shared `protocol-redeem` circuit remains source-wide. Yield cache verdicts carry nullable `generationId` / `publishedAt` from the served-generation sentinel; `cache-quality-degraded: yield-data:safety-snapshot-coverage` fires only below 0.75 coverage, held safety is `yield-safety-publish-time-fallback:safety-snapshot-held` inside both 24h clocks and `yield-safety-unrated-serving:safety-snapshot-held` beyond them, and unreadable or mismatched publication health fails closed as `yield-safety-availability-unknown`. Adds `headline`/`components`.",
    tags: ["Health"],
    responseSchema: "HealthResponse",
    postman: {
      noAuth: true,
    },
  },
  {
    key: "stablecoins",
    summary: "List stablecoins",
    description: "Current stablecoin list with supply, price, peg, chain distribution, FX context, and freshness headers. `_meta` publishes the generation, assessment time and effective fresh/degraded budgets; cache TTL and SWR are bounded by the remaining fresh runway. Since 2026-09-28, `StablecoinListResponse.peggedAssets[].chainCirculating` preserves unobserved `current`, `circulatingPrevDay`, `circulatingPrevWeek`, and `circulatingPrevMonth` values as `null` instead of the legacy projected `0`; omitted historical keys also mean unavailable. Explicit observed zero remains `0`. Consumers must not interpret unavailable chain observations as redemptions, mints, or a complete distribution denominator. Also since 2026-09-28 (pricing v6.38), nominal par routes carry par in `nominalPriceReference` (`{ price, source: \"protocol-par\", mode: \"nominal_reference\" }`) instead of a high-confidence `protocol-redeem` price stamped with the sync clock; non-USD par adds optional `fxReferenceType` (`fresh` or `static`) and `fxObservedAt` (the FX reference's own source time, `null` when unknown). A fresh market quote that depeg detection rates authoritative stays the published `price`; otherwise `price` is par with `priceSource` `protocol-par`, `priceObservedAtMode` `nominal_reference`, and `priceConfidence`, `priceObservedAt` and `priceUpdatedAt` `null`. Such a price is a nominal reference, not an observation.",
    tags: ["Stablecoins"],
    responseSchema: "StablecoinListResponse",
    postman: {
      name: "Stablecoins list",
    },
  },
  {
    key: "stablecoin-detail",
    responseSchema: "StablecoinDetailResponse",
    summary: "Stablecoin detail",
    description: "Full current/historical per-coin analytics dossier for a canonical Pharos stablecoin ID. Nominal references follow the [pricing v6.38 contract](https://pharos.watch/api/reference/#get-api-stablecoins).",
    tags: ["Stablecoins"],
    parameters: [STABLECOIN_ID_PARAM],
  },
  {
    key: "stablecoin-summary",
    responseSchema: "StablecoinSummaryResponse",
    summary: "Stablecoin summary",
    description: "Lightweight per-coin price and aggregate supply snapshot. Nominal references follow the [pricing v6.38 contract](https://pharos.watch/api/reference/#get-api-stablecoins).",
    tags: ["Stablecoins"],
    parameters: [STABLECOIN_ID_PARAM],
  },
  {
    key: "stablecoin-reserves",
    summary: "Stablecoin reserves",
    description: "Live or fallback reserve composition and reviewed provenance for live-reserve-enabled assets. Since 2026-09-27 the freshness verdict carries its policy values: `sync.freshness` publishes the assessment clock (`assessedAt`), judged generation (`fetchedAt`, `attemptId`), fetch age against the route's fetch budget, and, for verified source timestamps, source age against the effective source budget with the cap that set it; `provenance.scoringRejectionReasons` lists the admission gates behind `scoringEligible`. Both are additive optional fields, and unjudged or legacy values are `null`. Also since 2026-09-27, supply-comparing reserve snapshots publish `metadata.liabilityScope` (reviewed included/excluded chains with reasons), `supplyCoverageComplete`, `reserveObservedAt`, `supplyObservedAt`, and `ratioSkewSec`, and `metadata.collateralizationRatio` is omitted with `metadata.ratioUnavailableReason` when liability coverage or reserve/supply time identity is not established. USD1 now publishes `collateralizationRatio` over its reviewed issuer-native perimeter; the former USD1 `fundBackingTotalRatio` and `details.fundScope` fields are removed.",
    tags: ["Stablecoins", "Reserves"],
    responseSchema: "StablecoinReservesResponse",
    parameters: [STABLECOIN_ID_PARAM],
    postman: {
      path: "/api/stablecoin-reserves/{{reserveStablecoinId}}",
    },
  },
  {
    key: "stablecoin-charts",
    summary: "Stablecoin charts",
    description: "Historical total supply chart data.",
    tags: ["Stablecoins", "History"],
    responseSchema: "StablecoinChartResponse",
  },
  {
    key: "peg-summary",
    summary: "Peg summary",
    description: "Per-coin peg scores, reference evidence, coverage-aware recent metrics, and aggregate peg-monitoring summary. Since v6.31, `unknownCoverageSeconds` excludes merged blind spans from occupancy/penalties; wholly blind `pegPct`/`recent90d.pegPct` stay null. Recent `observedDays` excludes blind spans (`coverageLimited`). `currentDeviationBps`/`pegReference` ignore the $1M floor. `coinsAtPeg` uses raw canonical thresholds; row deviations stay rounded. Optional nullable `observationStartedAt`: earliest observed history, without PegScore age/audit/four-year clamps.",
    tags: ["Peg Monitoring"],
    responseSchema: "PegSummaryResponse",
  },
  {
    key: "depeg-events",
    summary: "Depeg incidents",
    description: "Historical and active depeg incidents with constituent threshold-crossing counts, filterable by asset, state, and review verdict. `total`/optional `totalExact` replace `counts`; sum `constituentEventCount` across pages for threshold-crossing totals. Audit verdicts (2026-09-28): confirmed/repaired/false_positive/disputed/no_data/null; unknowns rejected. v6.31 optional `priceCoverage`: off-peg `intervals` and `atParIntervals` ([startSec,endSec][]), nullable-second `lastTrustedObservationAt`/`gapStartedAt`, three-state `lastObservationKind`. Unrecorded spans are unknown. Open legacy null/absent coverage is unknown; closed legacy/replay durations are retained.",
    tags: ["Peg Monitoring"],
    responseSchema: "DepegEventsResponse",
    parameters: [
      STABLECOIN_QUERY_PARAM,
      LIMIT_PARAM,
      {
        name: "offset",
        in: "query",
        schema: { type: "integer", minimum: 0 },
        description: "Pagination offset.",
      },
      CURSOR_QUERY_PARAM,
      {
        name: "active",
        in: "query",
        schema: { type: "boolean" },
        description: "When true, returns active depeg events only.",
      },
      INCLUDE_TOTAL_QUERY_PARAM,
      {
        name: "includePending",
        in: "query",
        schema: { type: "boolean" },
        description: "When true, includes pending incidents awaiting confirmation.",
      },
    ],
    postman: {
      query: { stablecoin: "{{stablecoinId}}", limit: "{{limit}}", offset: "0" },
    },
  },
  {
    key: "events",
    summary: "Tape events",
    description: "Materialized chronological feed of typed events (depeg, freeze, score) backed by the tape_events table. Supports filtering by type, coin, severity floor, and time window, plus keyset pagination; cursor pagination is preferred for long result sets. `droppedRows` is the number of queried database rows rejected because they did not match the response schema; a non-zero value means the returned event set is incomplete, while `total` still counts those queried rows.",
    tags: ["Risk"],
    responseSchema: "TapeEventsResponse",
    parameters: [
      {
        name: "event",
        in: "query",
        schema: { type: "string", minLength: 1, maxLength: 200 },
        description: "Exact permalink event ID, independent of list filters. Returns one event with the normal response schema, or 404 with no event body. Retracted freeze claims return reason freeze-claim-retracted; retracted large mint/burn claims return flow-claim-retracted.",
      },
      {
        name: "type",
        in: "query",
        schema: { type: "string" },
        description: "Repeatable: exact event slug (e.g. depeg.opened) or prefix wildcard (depeg.*).",
      },
      {
        name: "class",
        in: "query",
        schema: { type: "string" },
        description: "Shortcut for type=<class>.* (e.g. class=depeg).",
      },
      {
        name: "coin",
        in: "query",
        schema: { type: "string" },
        description: "Repeatable canonical stablecoin id filter.",
      },
      {
        name: "pegCurrency",
        in: "query",
        schema: { type: "string" },
        description: "Filter to events for a specific peg currency.",
      },
      {
        name: "chain",
        in: "query",
        schema: { type: "string" },
        description: "Filter to events on a specific chain.",
      },
      {
        name: "q",
        in: "query",
        schema: { type: "string" },
        description: "Case-insensitive free-text search filter (trimmed and lowercased).",
      },
      {
        name: "severityFloor",
        in: "query",
        schema: { type: "string", enum: ["info", "notice", "warning", "severe", "critical"] },
        description: "Drop events below this severity.",
      },
      {
        name: "since",
        in: "query",
        schema: { type: "integer" },
        description: "Lower bound on ts (epoch ms, inclusive).",
      },
      {
        name: "until",
        in: "query",
        schema: { type: "integer" },
        description: "Upper bound on ts (epoch ms, inclusive).",
      },
      CURSOR_QUERY_PARAM,
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 500 },
        description: "Default 50, max 500.",
      },
      {
        name: "includeTotal",
        in: "query",
        schema: { type: "boolean" },
        description: "When true, computes the exact total count.",
      },
    ],
    postman: {
      query: { limit: "50" },
    },
  },
  {
    key: "usds-status",
    summary: "USDS freeze status",
    description: "Sky/USDS protocol status, including whether the freeze module is currently active.",
    tags: ["Risk"],
    responseSchema: "UsdsStatusResponse",
  },
  {
    key: "bluechip-ratings",
    summary: "Bluechip ratings",
    description: "Safety ratings from bluechip.org joined to Pharos identities for covered stablecoins.",
    tags: ["Risk"],
    responseSchema: "BluechipRatingsResponse",
  },
  {
    key: "dex-liquidity",
    summary: "DEX liquidity",
    description: "DEX liquidity scores, top pools, chain/protocol breakdowns, and quality metadata. Volume, activity and NR follow the [liquidity v6.9 volume contract](https://pharos.watch/docs/dex-liquidity/#measured-volume-availability). Empty datasets retain the confirmed producer output clock; absent authority publishes unavailable freshness, never request time.",
    tags: ["Liquidity"],
    responseSchema: "DexLiquidityResponse",
  },
  {
    key: "dex-liquidity-history",
    summary: "DEX liquidity history",
    description: "Bounded historical liquidity-score data for a stablecoin. `volume24h` and `score` follow the [liquidity v6.9 volume contract](https://pharos.watch/docs/dex-liquidity/#measured-volume-availability).",
    tags: ["Liquidity", "History"],
    responseSchema: "DexLiquidityHistoryResponse",
    parameters: [REQUIRED_STABLECOIN_QUERY_PARAM, DEX_LIQUIDITY_HISTORY_DAYS_PARAM],
    postman: {
      folder: "Historical data",
      order: 1,
      query: { stablecoin: "{{stablecoinId}}", days: "{{days}}" },
    },
  },
  {
    key: "report-cards-v9",
    summary: "Safety Score V9 report cards",
    description: "Canonical API schema-8 Safety Score report cards from the accepted internal schema-7 publication. Public cards carry resolved witness text without card-local witness tables. Rated partial cards retain excluded-pillar diagnostics; pipeline-gap is a null score and null grade, distinct from NR. See [Safety Score availability](https://pharos.watch/api/reference/#safety-score-availability).",
    tags: ["Risk"],
    responseSchema: "ReportCardsV9Response",
    parameters: [{
      name: "freshness", in: "query", schema: { type: "string", enum: ["operands"] },
      description: "Opt into compact pillarFreshness operands: dexMaxAgeSec and a dexObservedAtSec array aligned with cards. Assessment time is asOfSec and generation is source.sourceGenerations.dex. Omitted or unrecognized values preserve the historical categorical-only wire. Older accepted publications omit operands.",
    }],
  },
  {
    key: "safety-grades",
    summary: "Safety Score grades (no key)",
    description:
      "Free schema-1, no-key projection of the accepted V9 publication: nullable score/grade, ratingStatus and compact partialEvidence per tracked stablecoin, plus methodology version and publication status. Pipeline-gap never means NR. See [Safety Score availability](https://pharos.watch/api/reference/#safety-score-availability).",
    tags: ["Risk"],
    responseSchema: "SafetyGradesResponse",
    postman: {
      noAuth: true,
    },
  },
  {
    key: "dependency-graph-v1",
    summary: "Dependency graph (no key)",
    description:
      "Free schema-2 projection of the accepted V9 publication: publication-bound node supply, nullable grades, ratingStatus, compact partialEvidence, role summaries and coverage counts, with the published dependency edges unchanged. Held snapshots return no-store and X-Safety-Score-Status: held. See [Safety Score availability](https://pharos.watch/api/reference/#safety-score-availability).",
    tags: ["Risk"],
    responseSchema: "DependencyGraphResponse",
    postman: { noAuth: true },
  },
  {
    key: "dependency-scenarios",
    summary: "Modeled dependency scenarios (no key)",
    description:
      "Offline schema-2 production-evaluator scenarios from a V9 publication, refreshed daily. Published and modeled rows preserve ratingStatus, compact partialEvidence, nullable grades and null deltas for unavailable scores. Returns a nullable artifact and generation-bound freshness: current, earlier-generation within two days, stale beyond budget, or unavailable. Hypothetical results never alter canonical scores. See [Safety Score availability](https://pharos.watch/api/reference/#safety-score-availability).",
    tags: ["Risk"],
    responseSchema: "DependencyScenariosResponse",
    postman: { noAuth: true },
  },
  {
    key: "depeg-resolver",
    summary: "Depeg Duration Resolver",
    description:
      "Per active confirmed depeg: a mechanistic resolution outlook (terminal vs recoverable) and a stratified empirical duration estimate with per-horizon resolution likelihood. Since 2026-09-28, unknown audit verdicts fail closed; DDR excludes false_positive/disputed/no_data, PegScore only false_positive/disputed. Null keeps legacy eligibility.",
    tags: ["Risk", "Peg Monitoring"],
    responseSchema: "DdrResponse",
  },
  {
    key: "depeg-resolver-review",
    summary: "Depeg Duration Resolver Reviewer",
    description:
      "Review of stored DDR predictions against later depeg-event outcomes, including recovery-likelihood accuracy and observed-minus-predicted recovery duration error.",
    tags: ["Risk", "Peg Monitoring"],
    responseSchema: "DdrrResponse",
  },
  {
    key: "redemption-backstops",
    summary: "Redemption backstops",
    description: "Modeled issuer/protocol redemption routes and effective-exit scoring for configured assets.",
    tags: ["Risk", "Reserves"],
    responseSchema: "RedemptionBackstopsResponse",
  },
  {
    key: "stress-signals",
    summary: "Stress signals",
    description: "DEWS-style stress signals for the stablecoin universe or one selected asset. Each current row publishes assessedAt, freshBudgetSec, degradedBudgetSec and newestReturnedComputedAt alongside its generation and ageClassification. Aggregate retainedLastValid compares against the newest returned generation; single-asset rows publish a null comparison basis.",
    tags: ["Risk", "Peg Monitoring"],
    responseSchema: "StressSignalsResponse",
    parameters: [STABLECOIN_QUERY_PARAM, DAYS_PARAM],
    postman: {
      query: { stablecoin: "{{stablecoinId}}", days: "{{days}}" },
    },
  },
  {
    key: "stability-index",
    summary: "Pharos Stability Index",
    description: "PSI and history. Daily components preserve null versus observed zero; partial averages disclose `dailyProvenance.componentSampleCounts`. All-day averaging and mixed-version provenance remain intact; `componentsUnavailable` names gaps. Legacy counts remain unknown. Partial samples retain unpriced-event diagnostics and stored `current.inputDegradation.supplyUnavailableIds` / `trendUnavailableIds`. Unavailable supply is excluded from denominators and contributors; unusable aggregate market-cap or paired trend inputs retain the previous sample, never invented zero.",
    tags: ["Risk"],
    responseSchema: "StabilityIndexResponse",
    parameters: [
      {
        name: "detail",
        in: "query",
        schema: { type: "boolean" },
        description: "Includes components and full-history streak/event-score aggregates with source and response clocks.",
      },
      {
        name: "days",
        in: "query",
        schema: { type: "integer", minimum: 30, maximum: 365 },
        description: "Requires detail=true. Bounds rich history only; aggregates use full history. Omit for unbounded history.",
      },
    ],
    postman: {
      name: "Stability index",
      query: { detail: "true" },
    },
  },
  {
    key: "blacklist",
    summary: "Blacklist events",
    description: "Normalized issuer freeze, unfreeze, blacklist, and destruction events with optional uppercase symbol, chain display-name or chain ID, event type, search, sort, exact-count, and pagination filters. Responses include `chainId` join keys; the `chain` query filter is display-name based.",
    tags: ["Blacklist"],
    responseSchema: "BlacklistResponse",
    parameters: [
      BLACKLIST_STABLECOIN_SYMBOL_QUERY_PARAM,
      {
        name: "chain",
        in: "query",
        schema: { type: "string" },
        description: "Optional exact chain display-name filter, for example `Ethereum` or `Tron`. Use response `chainId` fields for programmatic joins.",
      },
      {
        name: "chainId",
        in: "query",
        schema: { type: "string" },
        description: "Optional canonical chain-registry ID filter, for example `ethereum` or `tron`. When both `chain` and `chainId` are supplied, they must identify the same chain.",
      },
      {
        name: "eventType",
        in: "query",
        schema: { type: "string", enum: ["blacklist", "unblacklist", "destroy"] },
        description: "Optional event type filter.",
      },
      {
        name: "q",
        in: "query",
        schema: { type: "string" },
        description: "Optional case-insensitive affected-address substring search.",
      },
      {
        name: "sortBy",
        in: "query",
        schema: { type: "string", enum: ["date", "stablecoin", "chain", "event"] },
        description: "Sort field. Defaults to `date`.",
      },
      {
        name: "sortDirection",
        in: "query",
        schema: { type: "string", enum: ["asc", "desc"] },
        description: "Sort direction. Defaults to `desc`.",
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 0, maximum: 1000 },
        description: "Maximum number of events to return. Defaults to 1000; `0` maps to the default.",
      },
      OFFSET_QUERY_PARAM,
      INCLUDE_TOTAL_QUERY_PARAM,
    ],
    postman: {
      query: {
        stablecoin: "{{blacklistStablecoinSymbol}}",
        chain: "Ethereum",
        chainId: "ethereum",
        eventType: "blacklist",
        q: "",
        sortBy: "date",
        sortDirection: "desc",
        limit: "{{limit}}",
        offset: "0",
        includeTotal: "true",
      },
    },
  },
  {
    key: "blacklist-summary",
    summary: "Blacklist summary",
    description: "Blacklist summary statistics, chart data, chain options, manifest-derived coverage metadata, and freeze-ledger data-quality context. Prefer tracked freeze-ledger fields over legacy active-state fields for public frozen exposure.",
    tags: ["Blacklist"],
    responseSchema: "BlacklistSummaryResponse",
  },
  {
    key: "mint-burn-flows",
    summary: "Mint and burn flows",
    description: "Mint/burn flow aggregates and pressure for closed UTC hours, not a rolling partial-hour window. `window` publishes `[start,end)` boundaries and `semantics: closed-utc-hours`; `end` is the current UTC hour boundary, excluding the open hour. Requested `hours` controls the aggregate series or per-coin totals; aggregate coin interpretation stays 24h, and 7d/30d/90d nets share that end. Signed nets are `null` when matching `valuation` is `partial`; gross volumes remain known-valuation lower bounds. Direction is withheld unless missing valuation cannot change it; pressure requires a complete 24h window and non-partial baseline. `gauge.score` re-weights over published pressures; `partialValuationInputs`, `partialValuationMcapUsd` and `scoredMcapUsd` disclose withheld weighted inputs and bound the full-cohort score by `(scoredMcapUsd·score ± 100·partialValuationMcapUsd) / (scoredMcapUsd + partialValuationMcapUsd)`. Flight-to-quality is withheld unless exact or provably inactive. Legacy `unknown` valuation keeps labelled nets until those buckets age out.",
    tags: ["Flows"],
    responseSchema: "MintBurnFlowsResponse",
    parameters: [STABLECOIN_QUERY_PARAM, HOURS_PARAM],
    postman: {
      query: { stablecoin: "{{stablecoinId}}", hours: "168" },
    },
  },
  {
    key: "mint-burn-events",
    summary: "Mint and burn events",
    description: "Normalized issuance event stream for supported stablecoins with cursor or offset pagination. Since 2026-09-28 (mint-burn-flow v6.23) `amountUsd` is set only from a price whose actual observation time is within 24 hours either side of the event, and `priceTimestamp` is that observation time: `priceSource` `supply-history-daily` / `supply-history-heal` for a daily snapshot price with a recorded observation clock (never its day label; nominal par is never stored), `price-cache-event-window` / `price_cache_heal` for a replay-safe observed cache price (never a legacy `protocol-redeem` par row of a nominal-par route); the candidate observed closest to the event wins. Events without such evidence keep `amountUsd: null`; this includes NAV tokens whose latest observation is more than 24 hours from the event (for example over weekends). Older rows may still carry `price-cache-current` with a run-time `priceTimestamp`, or `supply-history-daily` with the snapshot day as `priceTimestamp`.",
    tags: ["Flows"],
    responseSchema: "MintBurnEventsResponse",
    parameters: [
      REQUIRED_STABLECOIN_QUERY_PARAM,
      {
        name: "direction",
        in: "query",
        schema: { type: "string", enum: ["mint", "burn"] },
        description: "Optional direction filter.",
      },
      {
        name: "chain",
        in: "query",
        schema: { type: "string" },
        description: "Optional chain ID within the stablecoin's configured issuance scope.",
      },
      {
        name: "burnType",
        in: "query",
        schema: { type: "string", enum: ["effective_burn", "bridge_burn", "review_required"] },
        description: "Optional burn classification filter.",
      },
      {
        name: "scope",
        in: "query",
        schema: { type: "string", enum: ["all", "counted"] },
        description: "`counted` returns only rows used in economic-flow aggregates. Defaults to `all`.",
      },
      {
        name: "minAmount",
        in: "query",
        schema: { type: "number", minimum: 0 },
        description: "Minimum USD amount; unpriced rows are excluded when this filter is used.",
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 500 },
        description: "Maximum number of records to return. Defaults to 50.",
      },
      OFFSET_QUERY_PARAM,
      {
        name: "cursor",
        in: "query",
        schema: { type: "string" },
        description: "Opaque keyset cursor returned as nextCursor; cannot be combined with a non-zero offset.",
      },
      INCLUDE_TOTAL_QUERY_PARAM,
    ],
    postman: {
      query: {
        stablecoin: "{{stablecoinId}}",
        direction: "",
        chain: "ethereum",
        burnType: "",
        scope: "all",
        minAmount: "0",
        limit: "{{limit}}",
        offset: "0",
        includeTotal: "true",
      },
    },
  },
  {
    key: "yield-rankings",
    summary: "Yield rankings",
    description: "Yield-bearing stablecoin rankings with safety, benchmark-aware context, and optional publication/source-risk metadata fields. `?projection=summary` returns the compact workbench contract instead of the detailed rows.",
    tags: ["Yield"],
    responseSchema: "YieldRankingsResponse",
    additionalResponseSchemas: ["YieldRankingsSummaryResponse"],
    parameters: [
      {
        name: "projection",
        in: "query",
        schema: { type: "string", enum: ["summary"] },
        description: "Returns the compact Yield workbench contract while preserving the detailed response as the default.",
      },
    ],
    postman: {
      query: { projection: "" },
    },
  },
  {
    key: "yield-adapter-manifest",
    summary: "Yield adapter manifest",
    description:
      "Machine-readable source-list manifest for every yield-bearing asset, including adapter family, exact runtime source key when known, source-key pattern for runtime-resolved or disabled strategies, label, chain/project hints, lifecycle state, and methodology version.",
    tags: ["Yield"],
    responseSchema: "YieldAdapterManifestResponse",
  },
  {
    key: "yield-history",
    summary: "Yield history",
    description: "Historical yield observations for a stablecoin, with optional publication/source-risk metadata fields.",
    tags: ["Yield", "History"],
    responseSchema: "YieldHistoryResponse",
    parameters: [
      REQUIRED_STABLECOIN_QUERY_PARAM,
      DEX_LIQUIDITY_HISTORY_DAYS_PARAM,
      YIELD_HISTORY_MODE_PARAM,
      {
        name: "sourceKey",
        in: "query",
        schema: { type: "string" },
        description: "Required with `mode=source`; filters history to a single source key.",
      },
    ],
    postman: [
      {
        folder: "Historical data",
        order: 2,
        name: "Yield history - best source",
        description: "Historical best-source yield observations for a required stablecoin. `days` accepts 1-365; `mode=best` returns rows selected as best source at publication time.",
        query: { stablecoin: "{{stablecoinId}}", days: "{{days}}", mode: "best" },
      },
      {
        folder: "Historical data",
        order: 3,
        name: "Yield history - source key",
        description: "Source-specific historical yield observations. `mode=source` requires a stablecoin id plus `sourceKey` for the source series to inspect.",
        query: {
          stablecoin: "{{yieldSourceStablecoinId}}",
          days: "{{days}}",
          mode: "source",
          sourceKey: "{{yieldSourceKey}}",
        },
      },
    ],
  },
  {
    key: "chains",
    summary: "Chains",
    description: "Chain-level stablecoin aggregates with Chain Health Scores; pass `chain` for full per-chain coin detail rows. `_meta` discloses assessment time and the route's 1800/3600-second freshness bands; an unavailable or degraded Safety Score dependency can also downgrade the verdict. Cache lifetime is bounded by remaining fresh runway. Since 2026-09-27 chain accounting is raw: `chainAttributedTotalUsd` is the unclamped sum of the published chain rows (previously capped at `globalTotalUsd`), each `dominanceShare` is `totalUsd / globalTotalUsd` without rescaling (shares can sum above 1 when chain rows over-attribute supply), `attributionDiscrepancyUsd` is the signed `chainAttributedTotalUsd - globalTotalUsd`, `unattributedTotalUsd` is its positive residual, and `dominanceGeometryTotalUsd` (`max(global, attributed)`) is a bar-geometry denominator, never a share label. `supplyCoverage` and per-chain `unavailableSupplyObservationCount` count unobserved aggregate and chain supply excluded from those totals. Since Chain Health v1.6, zero peg coverage publishes `healthFactors.pegStability: null`; partial coverage publishes the observed-only factor with `pegStabilityCoverage`. Since v1.7, `healthScore`/`healthBand` also publish for partial coverage with `pegStabilityCoverage.coverage >= " + PEG_COVERAGE_COMPOSITE_MIN + "`; below that they are null. `neutralImputedSupplyUsd` is zero for new payloads; old cached payloads retain their original methodology. Since 2026-09-28 the unused V8 fields `_meta.dependencies.reportCards.inputsStale` and `_meta.dependencies.reportCards.staleInputs` are removed from the public contract; dependency status, age, and reason are unchanged.",
    tags: ["Chains"],
    responseSchema: "ChainsResponse",
    parameters: [CHAIN_QUERY_PARAM],
  },
  {
    key: "non-usd-share",
    responseSchema: "NonUsdShareResponse",
    summary: "Non-USD share",
    description: "Current and historical market share of tracked non-USD peg groups for market-structure views.",
    tags: ["Market Structure", "History"],
    parameters: [NON_USD_SHARE_DAYS_PARAM],
    postman: {
      query: { days: "{{days}}" },
    },
  },
  {
    key: "supply-history",
    summary: "Supply history",
    description: "Historical supply series for a stablecoin. Bounded days defaults to 365; range=all returns every retained daily observation under the same completed-snapshot fence. Nullable observations and producer freshness metadata are preserved.",
    tags: ["History"],
    responseSchema: "SupplyHistoryResponse",
    parameters: [REQUIRED_STABLECOIN_QUERY_PARAM, SUPPLY_HISTORY_DAYS_PARAM, SUPPLY_HISTORY_RANGE_PARAM],
    postman: [
      {
        order: 0,
        query: { stablecoin: "{{stablecoinId}}", days: "365" },
      },
      {
        name: "Supply history (all retained)",
        order: 0,
        query: { stablecoin: "{{stablecoinId}}", range: "all" },
      },
    ],
  },
  {
    key: "safety-score-history",
    summary: "Safety score history",
    description: "Legacy bounded long-range safety-score history for a stablecoin.",
    tags: ["Risk", "History"],
    responseSchema: "SafetyScoreHistoryResponse",
    parameters: [REQUIRED_STABLECOIN_QUERY_PARAM, SAFETY_SCORE_HISTORY_DAYS_PARAM],
    postman: {
      folder: "Historical data",
      order: 4,
      query: { stablecoin: "{{stablecoinId}}", days: "3650" },
    },
  },
  {
    key: "safety-score-history-v2",
    summary: "Safety score history (identity-aware)",
    description:
      "Boundary-aware safety-score history with full score-model identity and transition kinds; the legacy endpoint remains the V8 compatibility projection.",
    tags: ["Risk", "History"],
    responseSchema: "SafetyScoreHistoryV2Response",
    parameters: [REQUIRED_STABLECOIN_QUERY_PARAM, SAFETY_SCORE_HISTORY_DAYS_PARAM],
    postman: {
      folder: "Historical data",
      order: 5,
      query: { stablecoin: "{{stablecoinId}}", days: "3650" },
    },
  },
  {
    key: "daily-digest",
    summary: "Daily digest",
    description: "Latest AI-generated stablecoin market digest. With no eligible edition, all eleven response fields are explicitly null.",
    tags: ["Digest"],
    responseSchema: "DailyDigestResponse",
    postman: {
      order: 5,
    },
  },
  {
    key: "digest-archive",
    summary: "Digest archive",
    description: "Daily and weekly digest archive. The default response is bounded to the latest 365 rows. Use history=all and follow pagination.nextCursor until null for complete history within a captured insertion horizon; edition numbers are assigned before pagination.",
    tags: ["Digest"],
    responseSchema: "DigestArchiveResponse",
    parameters: [
      { name: "history", in: "query", required: false, schema: { type: "string", enum: ["all"] },
        description: "Opt into bounded cursor pages of complete retained history." },
      { name: "cursor", in: "query", required: false, schema: { type: "string" },
        description: "Continuation returned by pagination.nextCursor; requires history=all. Reuse unchanged." },
    ],
    postman: {
      order: 6,
    },
  },
  {
    key: "digest-snapshot",
    summary: "Digest snapshot",
    description: "Build-time digest context snapshot for a specific digest date.",
    tags: ["Digest"],
    responseSchema: "DigestSnapshotResponse",
    parameters: [
      {
        name: "date",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Digest date slug, for example `2026-03-16`.",
      },
    ],
    postman: {
      order: 7,
      query: { date: "{{digestDate}}" },
    },
  },
  {
    key: "snapshots-index",
    responseSchema: "SnapshotsIndexResponse",
    summary: "Public snapshot index",
    description:
      "Listing of available daily public snapshots with content hashes and methodology versions, newest first. Keyset-paginated: pass `pagination.nextCursor` as `cursor` while `pagination.hasMore` is true.",
    tags: ["Digest"],
    parameters: [
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 500 },
        description: "Maximum number of snapshot dates to return. Defaults to 500.",
      },
      {
        name: "cursor",
        in: "query",
        schema: { type: "string" },
        description: "Exclusive upper bound `YYYY-MM-DD` returned as `pagination.nextCursor`; pages older dates.",
      },
    ],
    postman: { order: 8 },
  },
  {
    key: "snapshot-day",
    summary: "Public snapshot for a single day",
    description:
      "Full per-day public dataset snapshot (camelCase). Immutable artifact keyed by YYYY-MM-DD; served unchanged with identity, ETag, and public, immutable, max-age=1y cache headers. Archive validation also applies to coin projections; live producers remain strict. Pre-9.15 cards may retain nullable `stressStateDigest`. Report7 uses recorded pre-10.11 routes and methodology-specific witness/obligation counts; see [historical contracts](https://pharos.watch/docs/report-cards/#report-schema-v8).",
    tags: ["Digest", "History"],
    parameters: [
      DATE_PATH_PARAM,
    ],
    postman: {
      order: 9,
      path: "/api/snapshots/{{snapshotDate}}.json",
    },
  },
  {
    key: "snapshot-coin",
    responseSchema: "SnapshotCoinResponse",
    summary: "Public snapshot projection for a single coin",
    description:
      "Per-coin slice of a daily snapshot (camelCase). Immutable artifact keyed by YYYY-MM-DD + stablecoin id; served with public, immutable, max-age=1y cache headers.",
    tags: ["Digest", "Stablecoins", "History"],
    parameters: [
      DATE_PATH_PARAM,
      {
        name: "stablecoinId",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Stablecoin id (lowercase-kebab).",
      },
    ],
    postman: {
      order: 10,
      path: "/api/snapshot/{{snapshotDate}}/stablecoin/{{stablecoinId}}",
    },
  },
  {
    key: "public-status-history",
    summary: "Public status history",
    description: "Bounded, public-safe status timeline for the Pharos system.",
    tags: ["Status"],
    responseSchema: "PublicStatusHistoryResponse",
    parameters: [
      LIMIT_PARAM,
      {
        name: "window",
        in: "query",
        schema: { type: "string", enum: ["24h", "7d", "30d"] },
        description: "Status history window.",
      },
    ],
    postman: {
      query: { window: "7d", limit: "{{limit}}" },
    },
  },
  {
    key: "telegram-pulse",
    summary: "Telegram pulse",
    description: "Lightweight public Telegram adoption and delivery-health aggregates.",
    tags: ["Status"],
    responseSchema: "TelegramPulseResponse",
    postman: {
      folder: "Flows, blacklist, yield, and chains",
    },
  },
] as const satisfies readonly PublicArtifactInput<EndpointKey>[];

export const PUBLIC_API_ARTIFACT_ENDPOINTS = PUBLIC_API_ARTIFACT_INPUTS.map((input) => definePublicArtifact(input));

export const PUBLIC_STATIC_POSTMAN_REQUESTS = [
  {
    name: "Stablecoin Cemetery dataset - JSON",
    path: "/datasets/stablecoin-cemetery.json",
    noAuth: true,
    base: "site",
    description: "Citation-ready JSON export of failed, abandoned, depegged, and discontinued stablecoins.",
  },
  {
    name: "Stablecoin Cemetery dataset - CSV",
    path: "/datasets/stablecoin-cemetery.csv",
    noAuth: true,
    base: "site",
    description: "Tabular CSV export of the Stablecoin Cemetery dataset.",
  },
  {
    name: "LLM index",
    path: "/llms.txt",
    noAuth: true,
    base: "site",
    description: "LLM-facing route and documentation index for Pharos.",
  },
] as const satisfies readonly PostmanStaticRequest[];
