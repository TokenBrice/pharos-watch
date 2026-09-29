#!/usr/bin/env node
/** Generates the public endpoint catalogue from OpenAPI and shared route policy. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENDPOINT_DEFINITIONS, type EndpointDefinition } from "@shared/lib/api-endpoints/definitions";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CACHE_FRESHNESS_LANES } from "@shared/lib/data-surface-descriptors";
import {
  BLACKLIST_TRACKER_METHODOLOGY_VERSION,
  CHAIN_HEALTH_METHODOLOGY_VERSION,
  DEPEG_DEWS_METHODOLOGY_VERSION,
  PSI_METHODOLOGY_VERSION,
  REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
  REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
  SAFETY_SCORE_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION,
} from "@shared/lib/methodology-versions/constants";
import {
  REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
  REDEMPTION_ROUTE_FAMILY_CAPS,
} from "@shared/lib/redemption-backstop-scoring";
import { RedemptionCapacityConfidenceSchema } from "@shared/types/redemption";
import { isRecord } from "@shared/lib/type-guards";
import { PEG_COVERAGE_COMPOSITE_MIN } from "@shared/lib/chains/health";

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const OPENAPI_PATH = resolve(ROOT, "public/openapi.json");
const DOC_PATH = resolve(ROOT, "docs/api-reference.md");
export const START_MARKER = "<!-- GENERATED-START: public-endpoints -->";
export const END_MARKER = "<!-- GENERATED-END: public-endpoints -->";

interface OpenApiSpec { paths: Record<string, unknown>; info?: Record<string, unknown> }
interface OpenApiRoute {
  method: string; path: string; operationId: string; summary: string; tags: string;
  parameters: string; responseCodes: string; responseSchemaRefs: readonly string[]; definition: EndpointDefinition;
}

const PUBLIC_OPERATION_ORDER = [
  "events", "stablecoins", "stablecoinStablecoinId", "stablecoinSummaryStablecoinId", "nonUsdShare", "chains",
  "stablecoinReservesStablecoinId", "stablecoinCharts", "blacklist", "blacklistSummary", "depegEvents",
  "depegResolver", "depegResolverReview", "pegSummary", "usdsStatus", "bluechipRatings", "dexLiquidity",
  "dexLiquidityHistory", "supplyHistory", "dailyDigest", "digestArchive", "digestSnapshot", "snapshotsIndex",
  "snapshotsDateJson", "snapshotDateStablecoinStablecoinId", "health", "publicStatusHistory", "telegramPulse",
  "stabilityIndex", "reportCardsV9", "safetyGrades", "redemptionBackstops", "safetyScoreHistory", "safetyScoreHistoryV2",
  "yieldRankings", "yieldAdapterManifest", "yieldHistory", "mintBurnFlows", "mintBurnEvents", "stressSignals",
] as const;
const SUPPLEMENTAL_ENDPOINT_ORDER = [
  "donor-key-claim", "feedback", "telegram-mini-app-session", "telegram-mini-app-mutation", "telegram-webhook",
] as const;

/** Hand-authored context, deliberately keyed by the stable OpenAPI operationId. */
export const CURATED_OPERATION_NOTES: Readonly<Record<string, string>> = {
  events: "Searches the normalized event tape; cursor pagination is preferred for long result sets. `droppedRows` is the number of queried database rows rejected because they did not match the response schema; a non-zero value means the returned event set is incomplete, while `total` still counts those queried rows.",
  stablecoins: "Returns the current stablecoin catalogue, prices, supply, chain breakdowns, and FX context. Since 2026-09-28, `StablecoinListResponse.peggedAssets[].chainCirculating` preserves unobserved `current`, `circulatingPrevDay`, `circulatingPrevWeek`, and `circulatingPrevMonth` values as `null` instead of the legacy projected `0`; omitted historical keys also mean unavailable. Explicit observed zero remains `0`. Consumers must not interpret unavailable chain observations as redemptions, mints, or a complete distribution denominator. Also since 2026-09-28 (pricing v6.38), nominal par routes carry par in `nominalPriceReference` (`{ price, source: \"protocol-par\", mode: \"nominal_reference\" }`) instead of a high-confidence `protocol-redeem` price stamped with the sync clock; non-USD par adds optional `fxReferenceType` (`fresh` or `static`) and `fxObservedAt` (the FX reference's own source time, `null` when unknown). A fresh market quote that depeg detection rates authoritative stays the published `price`; otherwise `price` is par with `priceSource` `protocol-par`, `priceObservedAtMode` `nominal_reference`, and `priceConfidence`, `priceObservedAt` and `priceUpdatedAt` `null`. Such a price is a nominal reference, not an observation.",
  stablecoinStablecoinId: "Returns the full current and historical detail payload for one canonical Pharos stablecoin ID. Since 2026-09-28 (pricing v6.38), nominal par routes may carry `nominalPriceReference`; a `priceObservedAtMode` of `nominal_reference` marks a published par reference, not an observed price.",
  stablecoinSummaryStablecoinId: "Returns the compact stablecoin projection used by lightweight consumers. Since 2026-09-28 (pricing v6.38), nominal par routes may carry `nominalPriceReference`; a `priceObservedAtMode` of `nominal_reference` marks a published par reference, not an observed price.",
  nonUsdShare: "Returns the current and historical market share of tracked non-USD peg groups.",
  chains: "Returns stablecoin distribution and health aggregates grouped by chain. Since 2026-09-27 chain accounting is raw: `chainAttributedTotalUsd` is the unclamped sum of the published chain rows (previously capped at `globalTotalUsd`), each `dominanceShare` is `totalUsd / globalTotalUsd` without rescaling (shares can sum above 1 when chain rows over-attribute supply), `attributionDiscrepancyUsd` is the signed `chainAttributedTotalUsd - globalTotalUsd`, `unattributedTotalUsd` is its positive residual, and `dominanceGeometryTotalUsd` (`max(global, attributed)`) is a bar-geometry denominator, never a share label. `supplyCoverage` and per-chain `unavailableSupplyObservationCount` count unobserved aggregate and chain supply excluded from those totals. Since Chain Health v1.6, zero peg coverage publishes `healthFactors.pegStability: null`; partial coverage publishes the observed-only factor with `pegStabilityCoverage`. Since v1.7, `healthScore`/`healthBand` also publish for partial coverage with `pegStabilityCoverage.coverage >= " + PEG_COVERAGE_COMPOSITE_MIN + "`; below that they are null. `neutralImputedSupplyUsd` is zero for new payloads; old cached payloads retain their original methodology. Since 2026-09-28 the unused V8 fields `_meta.dependencies.reportCards.inputsStale` and `_meta.dependencies.reportCards.staleInputs` are removed from the public contract; dependency status, age, and reason are unchanged.",
  stablecoinReservesStablecoinId: "Returns reviewed reserve composition and provenance for one stablecoin. Since 2026-09-27 the freshness verdict carries its policy values: `sync.freshness` publishes the assessment clock (`assessedAt`), judged generation (`fetchedAt`, `attemptId`), fetch age against the route's fetch budget, and, for verified source timestamps, source age against the effective source budget with the cap that set it; `provenance.scoringRejectionReasons` lists the admission gates behind `scoringEligible`. Both are additive optional fields, and unjudged or legacy values are `null`. Also since 2026-09-27, supply-comparing reserve snapshots publish `metadata.liabilityScope` (reviewed included/excluded chains with reasons), `supplyCoverageComplete`, `reserveObservedAt`, `supplyObservedAt`, and `ratioSkewSec`, and `metadata.collateralizationRatio` is omitted with `metadata.ratioUnavailableReason` when liability coverage or reserve/supply time identity is not established. USD1 now publishes `collateralizationRatio` over its reviewed issuer-native perimeter; the former USD1 `fundBackingTotalRatio` and `details.fundScope` fields are removed.",
  stablecoinCharts: "Returns the shared chart series consumed by stablecoin overview surfaces.",
  blacklist: "Returns normalized issuer freeze, unfreeze, blacklist, and destruction events.",
  blacklistSummary: "Returns aggregate blacklist counts and exposure totals.",
  depegEvents: "Returns detected depeg incidents with filters for asset, state, and review status. The response exposes pagination totals through `total` and optional `totalExact`; it no longer includes an aggregate `counts` field. Clients that need threshold-crossing totals should sum each event&rsquo;s `constituentEventCount` after loading all pages. Since 2026-09-28 `auditVerdict` accepts only confirmed, repaired, false_positive, disputed, no_data, or null; unknown archived verdicts are rejected rather than converted into scoreable evidence.",
  depegResolver: "Returns machine-resolved depeg-duration evidence used by risk surfaces. Since 2026-09-28 unknown audit verdicts fail closed. DDR excludes false_positive, disputed, and no_data; PegScore excludes false_positive and disputed but retains no_data. Null retains legacy eligibility.",
  depegResolverReview: "Returns the reviewer-oriented projection of depeg-duration decisions.",
  pegSummary: "Returns the current cross-market peg-monitoring summary.",
  usdsStatus: "Returns the current USDS freeze and operational-risk status.",
  bluechipRatings: "Returns imported Bluechip ratings joined to Pharos stablecoin identities.",
  dexLiquidity: "Returns current DEX liquidity scores and pool-level evidence. Volume, activity and NR follow the liquidity v6.9 volume contract above.",
  dexLiquidityHistory: "Returns bounded historical DEX liquidity observations for one stablecoin. `volume24h` and `score` follow the same v6.9 contract.",
  supplyHistory: "Returns bounded circulating-supply history for one stablecoin.",
  dailyDigest: "Returns the latest generated market digest.",
  digestArchive: "Returns the index of available dated digest snapshots.",
  digestSnapshot: "Returns one digest snapshot selected by date.",
  snapshotsIndex: "Returns the dates available in the public daily snapshot archive.",
  snapshotsDateJson: "Returns the full public snapshot captured for one date. Historical report-v5 cards from methodologies before 9.15 may retain a valid nullable `stressStateDigest`; archive validation accepts only that retired field while preserving the original payload and ETag. Current report producers remain strict. The same compatibility applies to dated coin projections.",
  snapshotDateStablecoinStablecoinId: "Returns one stablecoin projection from a dated public snapshot.",
  health: "Provides the unauthenticated availability canary; it is not the operator status dashboard. Since 2026-09-27 dedicated asset-scoped circuit outages no longer count as source-wide degradation; the shared `protocol-redeem` circuit remains source-wide.",
  publicStatusHistory: "Returns a bounded, public-safe status timeline.",
  telegramPulse: "Returns public Telegram adoption and delivery health aggregates.",
  stabilityIndex: "Returns the current Pharos Stability Index and optional component detail. Since 2026-09-28 (PSI v3.64), daily snapshots persist all-null components as null rather than zero. Observed zero remains numeric zero; partial components average only observations and disclose `dailyProvenance.componentSampleCounts`. All-day score averaging and mixed-version breakdown are retained; `componentsUnavailable` identifies unavailable components. Legacy rows without counts remain unknown, not assumed complete.",
  reportCardsV9: "Returns the currently published Safety Score V9 report-card set.",
  safetyGrades: "Returns one Safety Score and grade per tracked stablecoin from the same V9 publication, without an API key.",
  redemptionBackstops: "Returns reviewed redemption paths and backstop evidence.",
  safetyScoreHistory: "Returns legacy bounded Safety Score history for one stablecoin.",
  safetyScoreHistoryV2: "Returns identity-aware bounded Safety Score history for one stablecoin.",
  yieldRankings: "Returns current Yield Intelligence rankings and risk-adjusted fields.",
  yieldAdapterManifest: "Returns the public adapter-coverage and source-status manifest.",
  yieldHistory: "Returns bounded yield history for one stablecoin and optional source projection.",
  mintBurnFlows: "Returns aggregate mint and burn pressure over the requested window. Since 2026-09-28 (mint-burn-flow v6.23) signed nets (`netFlow24hUsd`, `netFlow7dUsd`, `netFlow30dUsd`, `netFlow90dUsd`, chain `netFlow24hUsd`, per-coin and hourly `netFlowUsd`) are `null` when the matching `valuation` is `partial`; gross mint/burn volumes remain known-valuation lower bounds. `netFlowDirection24h` is `null` unless missing valuation cannot change it, `pressureShiftScore` is `null` (state `nr`) unless the 24h window is `complete` and the baseline is not `partial`, and `gauge.flightToQuality` / `gauge.flightIntensity` are `null` unless exact or provably inactive. `gauge.score` re-weights over coins whose pressure is published; `gauge.partialValuationInputs` counts weighted coins with at least seven days of baseline history whose pressure was withheld for incomplete valuation, the additive `gauge.partialValuationMcapUsd` their weight and `gauge.scoredMcapUsd` the weight actually scored, so the full-cohort score lies within `(scoredMcapUsd·score ± 100·partialValuationMcapUsd) / (scoredMcapUsd + partialValuationMcapUsd)`. Windows with legacy `unknown` coverage keep their nets, labelled by `valuation`, until those buckets age out.",
  mintBurnEvents: "Returns the normalized issuance event stream with cursor or offset pagination. Since 2026-09-28 (mint-burn-flow v6.23) `amountUsd` is set only from a price whose actual observation time is within 24 hours either side of the event, and `priceTimestamp` is that observation time: `priceSource` `supply-history-daily` / `supply-history-heal` for a daily snapshot price with a recorded observation clock (never its day label; nominal par is never stored), `price-cache-event-window` / `price_cache_heal` for a replay-safe observed cache price (never a legacy `protocol-redeem` par row of a nominal-par route); the candidate observed closest to the event wins. Events without such evidence keep `amountUsd: null`; this includes NAV tokens whose latest observation is more than 24 hours from the event (for example over weekends). Older rows may still carry `price-cache-current` with a run-time `priceTimestamp`, or `supply-history-daily` with the snapshot day as `priceTimestamp`.",
  stressSignals: "Returns the bounded stress-signal history used by early-warning surfaces.",
};
const SUPPLEMENTAL_NOTES: Readonly<Record<(typeof SUPPLEMENTAL_ENDPOINT_ORDER)[number], string>> = {
  "donor-key-claim": "Issues one non-expiring supporter API key to a donor wallet that signs a Sign-In-With-Ethereum claim message.",
  feedback: "Accepts the bounded feedback form payload used by the website.",
  "telegram-mini-app-session": "Creates or refreshes a Telegram Mini App session after Telegram init-data validation.",
  "telegram-mini-app-mutation": "Applies an authenticated Telegram Mini App preference mutation.",
  "telegram-webhook": "Receives Telegram Bot API updates; callers outside Telegram should not use it.",
};

export function loadOpenapi(path = OPENAPI_PATH): OpenApiSpec {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.paths)) throw new Error("openapi.json is missing `paths`");
  return { paths: parsed.paths, info: isRecord(parsed.info) ? parsed.info : undefined };
}
function escapeCell(value: unknown): string { return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|") }
function displayPath(path: string): string {
  return path.replaceAll("{stablecoinId}", ":id").replaceAll("{date}", ":date");
}
function parameterType(parameter: Record<string, unknown>): string {
  const schema = isRecord(parameter.schema) ? parameter.schema : undefined;
  return typeof schema?.type === "string" ? schema.type : "value";
}
function formatParams(parameters: unknown): string {
  if (!Array.isArray(parameters) || parameters.length === 0) return "None.";
  return parameters.filter(isRecord).map((parameter) => {
    const location = typeof parameter.in === "string" ? parameter.in : "request";
    return `\`${String(parameter.name ?? "")}\` (${location}, ${parameter.required ? "required" : "optional"}, ${parameterType(parameter)})`;
  }).join("; ");
}
function responseSchemaRefs(operation: Record<string, unknown>): readonly string[] {
  if (!isRecord(operation.responses)) return [];
  for (const code of Object.keys(operation.responses).sort()) {
    if (!code.startsWith("2")) continue;
    const response = operation.responses[code];
    if (!isRecord(response) || !isRecord(response.content)) continue;
    const json = response.content["application/json"];
    if (!isRecord(json) || !isRecord(json.schema)) continue;
    const schema = json.schema;
    if (typeof schema.$ref === "string") return [schema.$ref];
    // Query-parameter variants (e.g. `?projection=summary`) are published as a
    // `oneOf`; document every ref instead of reporting no schema at all.
    if (Array.isArray(schema.oneOf)) {
      return schema.oneOf
        .filter((variant): variant is { $ref: string } => isRecord(variant) && typeof variant.$ref === "string")
        .map((variant) => variant.$ref);
    }
  }
  return [];
}
function findDefinition(path: string, method: string): EndpointDefinition {
  const normalized = displayPath(path);
  const definition = ENDPOINT_DEFINITIONS.find((candidate) =>
    candidate.path === normalized && candidate.methods.includes(method as "GET" | "HEAD" | "POST"));
  if (!definition || definition.adminRequired) throw new Error(`No public endpoint definition matches ${method} ${path}`);
  return definition;
}
export function collectOpenApiRoutes(spec: OpenApiSpec): OpenApiRoute[] {
  const routes: OpenApiRoute[] = [];
  for (const [path, pathValue] of Object.entries(spec.paths)) {
    if (!isRecord(pathValue)) continue;
    for (const methodName of ["get", "post", "put", "patch", "delete", "options", "head"]) {
      const operation = pathValue[methodName];
      if (!isRecord(operation)) continue;
      const operationId = typeof operation.operationId === "string" ? operation.operationId : "";
      if (!operationId || !CURATED_OPERATION_NOTES[operationId]) throw new Error(`Missing curated note for ${methodName.toUpperCase()} ${path}`);
      const method = methodName.toUpperCase();
      const parameters = [...(Array.isArray(pathValue.parameters) ? pathValue.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      routes.push({
        method, path, operationId,
        summary: typeof operation.summary === "string" ? operation.summary : operationId,
        tags: Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string").join(", ") : "",
        parameters: formatParams(parameters),
        responseCodes: isRecord(operation.responses) ? Object.keys(operation.responses).sort().join(", ") : "",
        responseSchemaRefs: responseSchemaRefs(operation), definition: findDefinition(path, method),
      });
    }
  }
  const order = new Map<string, number>(PUBLIC_OPERATION_ORDER.map((operationId, index) => [operationId, index]));
  return routes.sort((a, b) => (order.get(a.operationId) ?? 999) - (order.get(b.operationId) ?? 999));
}
function authLabel(definition: EndpointDefinition): string {
  return definition.publicApiAccess === "exempt" ? "exempt" : "`X-API-Key` required";
}
function cacheLabel(definition: EndpointDefinition): string {
  return definition.cacheBypass ? "bypass shared endpoint caching" : "shared endpoint caching allowed";
}
function schemaLink(refs: readonly string[]): string {
  if (refs.length === 0) return "No JSON success schema is published.";
  return refs
    .map((ref) => `[\`${ref.split("/").at(-1) ?? ref}\`](https://pharos.watch/openapi.json${ref})`)
    .join(", ");
}
function renderQuickReference(routes: readonly OpenApiRoute[]): string {
  return [
    "| Method | Path | Summary | Tags | Auth | Parameters | Status codes |",
    "| ------ | ---- | ------- | ---- | ---- | ---------- | ------------ |",
    ...routes.map((route) => `| ${route.method} | \`${escapeCell(route.path)}\` | ${escapeCell(route.summary)} | ${escapeCell(route.tags)} | ${authLabel(route.definition)} | ${route.parameters === "None." ? "—" : escapeCell(route.parameters)} | ${route.responseCodes} |`),
  ].join("\n");
}
function renderHealthFreshnessExample(): string {
  const caches = Object.fromEntries(Object.values(CACHE_FRESHNESS_LANES).map((lane) => [
    lane.cacheKey,
    {
      maxAge: lane.availabilityMaxAgeSec,
      endpointMaxAge: lane.endpointMaxAgeSec,
      producerIntervalSec: lane.producerIntervalSec,
    },
  ]));
  return [
    "**Source-backed health freshness example**",
    "",
    "```json",
    JSON.stringify({ caches }, null, 2),
    "```",
  ].join("\n");
}
function renderRedemptionBackstopContract(): string {
  const versionLabel = `v${REDEMPTION_BACKSTOP_METHODOLOGY_VERSION}`;
  const responseExample = {
    coins: {},
    methodology: {
      version: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
      versionLabel,
      currentVersion: REDEMPTION_BACKSTOP_METHODOLOGY_VERSION,
      currentVersionLabel: versionLabel,
      changelogPath: REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH,
      asOf: 0,
      isCurrent: true,
      componentWeights: REDEMPTION_BACKSTOP_COMPONENT_WEIGHTS,
      routeFamilyCaps: REDEMPTION_ROUTE_FAMILY_CAPS,
    },
    updatedAt: 0,
    snapshotSource: "run-rows",
  };
  return [
    "**Minimal response example**",
    "",
    "```json",
    JSON.stringify(responseExample, null, 2),
    "```",
    "",
    `**Capacity-confidence vocabulary:** ${RedemptionCapacityConfidenceSchema.options.map((value) => `\`${value}\``).join(", ")}.`,
  ].join("\n");
}
function currentMethodologyExample(operationId: string): Record<string, string> | null {
  switch (operationId) {
    case "blacklist":
      return {
        currentVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION,
        currentVersionLabel: `v${BLACKLIST_TRACKER_METHODOLOGY_VERSION}`,
      };
    case "depegEvents":
    case "pegSummary":
      return { currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION };
    case "stabilityIndex":
      return { currentVersion: PSI_METHODOLOGY_VERSION, methodologyVersion: PSI_METHODOLOGY_VERSION };
    case "reportCardsV9":
      return { version: SAFETY_SCORE_METHODOLOGY_VERSION, methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION };
    case "yieldRankings":
      return { currentVersion: YIELD_METHODOLOGY_VERSION, methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION };
    case "yieldAdapterManifest":
      return { methodologyVersion: `v${YIELD_METHODOLOGY_VERSION}` };
    case "yieldHistory":
      return { currentVersion: YIELD_METHODOLOGY_VERSION, methodologyVersion: YIELD_METHODOLOGY_VERSION };
    case "stressSignals":
      return { currentVersion: DEPEG_DEWS_METHODOLOGY_VERSION, methodologyVersion: DEPEG_DEWS_METHODOLOGY_VERSION };
    default:
      return null;
  }
}
function renderSourceBackedRouteDetails(operationId: string): string | null {
  const lines: string[] = [];
  if (operationId === "stablecoins") {
    lines.push([
      "**Compatibility response fields**",
      "",
      "| Field | Type | Description |",
      "| ----- | ---- | ----------- |",
      "| `geckoId` | `string \\| null` | CoinGecko ID (normalized output key; upstream DefiLlama uses `gecko_id`) |",
    ].join("\n"));
  }
  if (operationId === "health") lines.push(renderHealthFreshnessExample());
  if (operationId === "redemptionBackstops") lines.push(renderRedemptionBackstopContract());
  if (operationId === "chains") {
    lines.push([
      "**Source-backed chain methodology example**",
      "",
      "```json",
      JSON.stringify({ healthMethodologyVersion: CHAIN_HEALTH_METHODOLOGY_VERSION }, null, 2),
      "```",
    ].join("\n"));
  }
  if (operationId === "stressSignals") {
    lines.push(`Freshness threshold: ${API_FRESHNESS_MAX_AGE_SEC.stressSignals} s.`);
  }
  const methodology = currentMethodologyExample(operationId);
  if (methodology) {
    lines.push([
      "**Current methodology example**",
      "",
      "```json",
      JSON.stringify(methodology, null, 2),
      "```",
    ].join("\n"));
  }
  return lines.length > 0 ? lines.join("\n\n") : null;
}
function renderOpenApiRoute(route: OpenApiRoute): string {
  const sourceBackedDetails = renderSourceBackedRouteDetails(route.operationId);
  return [
    `### \`${route.method} ${displayPath(route.path)}\``, "", CURATED_OPERATION_NOTES[route.operationId], "",
    `- **Operation ID:** \`${route.operationId}\``, `- **Path:** \`${route.path}\``,
    `- **Parameters:** ${route.parameters}`, `- **Success response schema:** ${schemaLink(route.responseSchemaRefs)}`,
    `- **Policy:** authentication ${authLabel(route.definition)}; ${cacheLabel(route.definition)} (\`cacheBypass: ${route.definition.cacheBypass}\`).`,
    ...(sourceBackedDetails ? ["", sourceBackedDetails] : []),
  ].join("\n");
}
function renderSupplementalRoute(definition: EndpointDefinition): string {
  const method = definition.methods[0] ?? "POST";
  return [
    `### \`${method} ${definition.path}\``, "", SUPPLEMENTAL_NOTES[definition.key as keyof typeof SUPPLEMENTAL_NOTES], "",
    `- **Registry key:** \`${definition.key}\``, `- **Path:** \`${definition.path}\``,
    "- **Parameters:** See the website client contract; this route is intentionally excluded from the public OpenAPI integration surface.",
    "- **Success response schema:** Not published in `openapi.json`.",
    `- **Policy:** authentication ${authLabel(definition)}; ${cacheLabel(definition)} (\`cacheBypass: ${definition.cacheBypass}\`).`,
  ].join("\n");
}
function renderOgRoute(): string {
  return [
    "### `GET /api/og/*`", "",
    "Dynamic social-card image routes are served by the Worker and intentionally omitted from OpenAPI.", "",
    "- **Path:** `/api/og/*`",
    "- **Parameters:** Route-specific path segments select the supported image family.",
    "- **Success response schema:** PNG image bytes; not represented by a JSON component schema.",
    "- **Policy:** API-key authentication exempt; route-specific response caching.",
  ].join("\n");
}
export function renderGeneratedBlock(spec: OpenApiSpec): string {
  const routes = collectOpenApiRoutes(spec);
  if (routes.length !== PUBLIC_OPERATION_ORDER.length) throw new Error(`Expected ${PUBLIC_OPERATION_ORDER.length} OpenAPI operations, found ${routes.length}`);
  const supplemental = SUPPLEMENTAL_ENDPOINT_ORDER.map((key) => {
    const definition = ENDPOINT_DEFINITIONS.find((candidate) => candidate.key === key);
    if (!definition || definition.adminRequired) throw new Error(`Missing public endpoint definition ${key}`);
    return definition;
  });
  const routeSections = routes.flatMap((route) => [
    renderOpenApiRoute(route), "",
    ...(route.operationId === "stabilityIndex" ? [renderOgRoute(), ""] : []),
  ]);
  return [
    START_MARKER,
    "<!-- Generated by scripts/maintenance/generate-api-reference.ts from public/openapi.json and shared/lib/api-endpoints/definitions.ts. -->",
    "<!-- Curated route notes are authored in the generator and keyed by operationId. Do not edit this block by hand. -->", "",
    "### Public Endpoints Quick Reference", "",
    `Generated from \`public/openapi.json\` (\`${typeof spec.info?.title === "string" ? spec.info.title : "Pharos API"}\` v${typeof spec.info?.version === "string" ? spec.info.version : ""}). Total OpenAPI operations: **${routes.length}**.`, "",
    renderQuickReference(routes), "", ...routeSections,
    ...supplemental.flatMap((definition) => [renderSupplementalRoute(definition), ""]), END_MARKER,
  ].join("\n");
}
export function replaceGeneratedBlock(doc: string, generatedBlock: string): string {
  const oldStart = "<!-- GENERATED-START: public-endpoints-quick-reference -->";
  const oldEnd = "<!-- GENERATED-END: public-endpoints-quick-reference -->";
  const startMarker = doc.includes(START_MARKER) ? START_MARKER : oldStart;
  const endMarker = doc.includes(END_MARKER) ? END_MARKER : oldEnd;
  const start = doc.indexOf(startMarker); const end = doc.indexOf(endMarker);
  if (start === -1 || end === -1 || end < start) throw new Error(`Could not find a valid generated block in ${DOC_PATH}`);
  return `${doc.slice(0, start)}${generatedBlock}${doc.slice(end + endMarker.length)}`;
}
export function main(checkMode = process.argv.includes("--check")): void {
  const existing = readFileSync(DOC_PATH, "utf8");
  const next = replaceGeneratedBlock(existing, renderGeneratedBlock(loadOpenapi()));
  if (checkMode && next !== existing) { console.error("docs/api-reference.md is out of date. Run `node --import tsx scripts/maintenance/generate-api-reference.ts`."); process.exitCode = 1; return }
  if (checkMode) { console.log("docs/api-reference.md is current"); return }
  if (next === existing) { console.log("docs/api-reference.md unchanged"); return }
  writeFileSync(DOC_PATH, next, "utf8"); console.log("docs/api-reference.md regenerated");
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
