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

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const OPENAPI_PATH = resolve(ROOT, "public/openapi.json");
const DOC_PATH = resolve(ROOT, "docs/api-reference.md");
export const START_MARKER = "<!-- GENERATED-START: public-endpoints -->";
export const END_MARKER = "<!-- GENERATED-END: public-endpoints -->";

interface OpenApiSpec { paths: Record<string, unknown>; info?: Record<string, unknown> }
interface OpenApiRoute {
  method: string; path: string; operationId: string; summary: string; tags: string;
  parameters: string; responseCodes: string; responseSchemaRef: string | null; definition: EndpointDefinition;
}

const PUBLIC_OPERATION_ORDER = [
  "events", "stablecoins", "stablecoinStablecoinId", "stablecoinSummaryStablecoinId", "nonUsdShare", "chains",
  "stablecoinReservesStablecoinId", "stablecoinCharts", "blacklist", "blacklistSummary", "depegEvents",
  "depegResolver", "depegResolverReview", "pegSummary", "usdsStatus", "bluechipRatings", "dexLiquidity",
  "dexLiquidityHistory", "supplyHistory", "dailyDigest", "digestArchive", "digestSnapshot", "snapshotsIndex",
  "snapshotsDateJson", "snapshotDateStablecoinStablecoinId", "health", "publicStatusHistory", "telegramPulse",
  "stabilityIndex", "reportCardsV9", "redemptionBackstops", "safetyScoreHistory", "safetyScoreHistoryV2",
  "yieldRankings", "yieldAdapterManifest", "yieldHistory", "mintBurnFlows", "mintBurnEvents", "stressSignals",
] as const;
const SUPPLEMENTAL_ENDPOINT_ORDER = [
  "api-key-requests", "api-key-request-verify", "feedback", "telegram-mini-app-session",
  "telegram-mini-app-mutation", "telegram-webhook",
] as const;

/** Hand-authored context, deliberately keyed by the stable OpenAPI operationId. */
export const CURATED_OPERATION_NOTES: Readonly<Record<string, string>> = {
  events: "Searches the normalized event tape; cursor pagination is preferred for long result sets.",
  stablecoins: "Returns the current stablecoin catalogue, prices, supply, chain breakdowns, and FX context.",
  stablecoinStablecoinId: "Returns the full current and historical detail payload for one canonical Pharos stablecoin ID.",
  stablecoinSummaryStablecoinId: "Returns the compact stablecoin projection used by lightweight consumers.",
  nonUsdShare: "Returns the current and historical market share of tracked non-USD peg groups.",
  chains: "Returns stablecoin distribution and health aggregates grouped by chain.",
  stablecoinReservesStablecoinId: "Returns reviewed reserve composition and provenance for one stablecoin.",
  stablecoinCharts: "Returns the shared chart series consumed by stablecoin overview surfaces.",
  blacklist: "Returns normalized issuer freeze, unfreeze, blacklist, and destruction events.",
  blacklistSummary: "Returns aggregate blacklist counts and exposure totals.",
  depegEvents: "Returns detected depeg incidents with filters for asset, state, and review status.",
  depegResolver: "Returns machine-resolved depeg-duration evidence used by risk surfaces.",
  depegResolverReview: "Returns the reviewer-oriented projection of depeg-duration decisions.",
  pegSummary: "Returns the current cross-market peg-monitoring summary.",
  usdsStatus: "Returns the current USDS freeze and operational-risk status.",
  bluechipRatings: "Returns imported Bluechip ratings joined to Pharos stablecoin identities.",
  dexLiquidity: "Returns current DEX liquidity scores and pool-level evidence.",
  dexLiquidityHistory: "Returns bounded historical DEX liquidity observations for one stablecoin.",
  supplyHistory: "Returns bounded circulating-supply history for one stablecoin.",
  dailyDigest: "Returns the latest generated market digest.",
  digestArchive: "Returns the index of available dated digest snapshots.",
  digestSnapshot: "Returns one digest snapshot selected by date.",
  snapshotsIndex: "Returns the dates available in the public daily snapshot archive.",
  snapshotsDateJson: "Returns the full public snapshot captured for one date.",
  snapshotDateStablecoinStablecoinId: "Returns one stablecoin projection from a dated public snapshot.",
  health: "Provides the unauthenticated availability canary; it is not the operator status dashboard.",
  publicStatusHistory: "Returns a bounded, public-safe status timeline.",
  telegramPulse: "Returns public Telegram adoption and delivery health aggregates.",
  stabilityIndex: "Returns the current Pharos Stability Index and optional component detail.",
  reportCardsV9: "Returns the currently published Safety Score V9 report-card set.",
  redemptionBackstops: "Returns reviewed redemption paths and backstop evidence.",
  safetyScoreHistory: "Returns legacy bounded Safety Score history for one stablecoin.",
  safetyScoreHistoryV2: "Returns identity-aware bounded Safety Score history for one stablecoin.",
  yieldRankings: "Returns current Yield Intelligence rankings and risk-adjusted fields.",
  yieldAdapterManifest: "Returns the public adapter-coverage and source-status manifest.",
  yieldHistory: "Returns bounded yield history for one stablecoin and optional source projection.",
  mintBurnFlows: "Returns aggregate mint and burn pressure over the requested window.",
  mintBurnEvents: "Returns the normalized issuance event stream with cursor or offset pagination.",
  stressSignals: "Returns the bounded stress-signal history used by early-warning surfaces.",
};
const SUPPLEMENTAL_NOTES: Readonly<Record<(typeof SUPPLEMENTAL_ENDPOINT_ORDER)[number], string>> = {
  "api-key-requests": "Starts the email-verified public API access flow.",
  "api-key-request-verify": "Completes a public API key request with the emailed verification token.",
  feedback: "Accepts the bounded feedback form payload used by the website.",
  "telegram-mini-app-session": "Creates or refreshes a Telegram Mini App session after Telegram init-data validation.",
  "telegram-mini-app-mutation": "Applies an authenticated Telegram Mini App preference mutation.",
  "telegram-webhook": "Receives Telegram Bot API updates; callers outside Telegram should not use it.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
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
function responseSchemaRef(operation: Record<string, unknown>): string | null {
  if (!isRecord(operation.responses)) return null;
  for (const code of Object.keys(operation.responses).sort()) {
    if (!code.startsWith("2")) continue;
    const response = operation.responses[code];
    if (!isRecord(response) || !isRecord(response.content)) continue;
    const json = response.content["application/json"];
    if (isRecord(json) && isRecord(json.schema) && typeof json.schema.$ref === "string") return json.schema.$ref;
  }
  return null;
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
        responseSchemaRef: responseSchemaRef(operation), definition: findDefinition(path, method),
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
function schemaLink(ref: string | null): string {
  if (!ref) return "No JSON success schema is published.";
  return `[\`${ref.split("/").at(-1) ?? ref}\`](https://pharos.watch/openapi.json${ref})`;
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
    `- **Parameters:** ${route.parameters}`, `- **Success response schema:** ${schemaLink(route.responseSchemaRef)}`,
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
