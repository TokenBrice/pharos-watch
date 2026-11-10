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

const ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const OPENAPI_PATH = resolve(ROOT, "public/openapi.json");
const DOC_PATH = resolve(ROOT, "docs/api-reference.md");
export const START_MARKER = "<!-- GENERATED-START: public-endpoints -->";
export const END_MARKER = "<!-- GENERATED-END: public-endpoints -->";

interface OpenApiSpec { paths: Record<string, unknown>; info?: Record<string, unknown> }
interface OpenApiRoute {
  method: string; path: string; operationId: string; summary: string; description: string; tags: string;
  parameters: string; responseCodes: string; responseSchemaRefs: readonly string[]; definition: EndpointDefinition;
}

const PUBLIC_OPERATION_ORDER = [
  "events", "stablecoins", "stablecoinStablecoinId", "stablecoinSummaryStablecoinId", "nonUsdShare", "chains",
  "stablecoinReservesStablecoinId", "stablecoinCharts", "blacklist", "blacklistSummary", "depegEvents",
  "depegResolver", "depegResolverReview", "pegSummary", "usdsStatus", "bluechipRatings", "dexLiquidity",
  "dexLiquidityHistory", "supplyHistory", "dailyDigest", "digestArchive", "digestSnapshot", "snapshotsIndex",
  "snapshotsDateJson", "snapshotDateStablecoinStablecoinId", "health", "publicStatusHistory", "telegramPulse",
  "stabilityIndex", "reportCardsV9", "safetyGrades", "dependencyGraphV1", "dependencyScenariosV1", "redemptionBackstops", "safetyScoreHistory", "safetyScoreHistoryV2",
  "yieldRankings", "yieldAdapterManifest", "yieldHistory", "mintBurnFlows", "mintBurnEvents", "stressSignals",
] as const;
const SUPPLEMENTAL_ENDPOINT_ORDER = [
  "donor-key-claim", "feedback", "telegram-mini-app-session", "telegram-mini-app-mutation", "telegram-webhook",
] as const;

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
      if (!operationId) throw new Error(`Missing operationId for ${methodName.toUpperCase()} ${path}`);
      if (typeof operation.description !== "string" || !operation.description.trim()) {
        throw new Error(`Missing description for ${methodName.toUpperCase()} ${path}`);
      }
      const method = methodName.toUpperCase();
      const parameters = [...(Array.isArray(pathValue.parameters) ? pathValue.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])];
      routes.push({
        method, path, operationId,
        summary: typeof operation.summary === "string" ? operation.summary : operationId,
        description: operation.description,
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
function currentMethodologyExample(operationId: string): Record<string, string | Record<string, string>> | null {
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
    case "yieldRankings":
      return { currentVersion: YIELD_METHODOLOGY_VERSION, methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION };
    case "yieldAdapterManifest":
      return { methodologyVersion: YIELD_METHODOLOGY_VERSION };
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
  const preview = route.description.split(/(?<=[.!?])\s/, 1)[0];
  const operationPath = route.path.replaceAll("~", "~0").replaceAll("/", "~1");
  return [
    `### \`${route.method} ${displayPath(route.path)}\``, "",
    `${preview} [Full endpoint contract](https://pharos.watch/openapi.json#/paths/${operationPath}/${route.method.toLowerCase()}).`, "",
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
    "Dynamic social-card PNGs, omitted from OpenAPI. Unavailable inputs stay unavailable; labels keep source time; freshness headers name budget and generation ([OG Images](./og-images.md#8-dynamic-worker-cards-apiog)). `/api/og/page/:slug` serves a stamped route figure, or the route's timeless card (`200`, `X-Og-Reason`) when its source is missing, stale, held or failing.", "",
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
    "<!-- Endpoint narratives are authored in scripts/lib/public-api-artifact-catalog.ts and emitted through OpenAPI. Supplemental notes and source-backed examples live in the generator. Do not edit this block by hand. -->", "",
    "### Public Endpoints Quick Reference", "",
    `Generated from \`public/openapi.json\` (\`${typeof spec.info?.title === "string" ? spec.info.title : "Pharos API"}\` v${typeof spec.info?.version === "string" ? spec.info.version : ""}). Total OpenAPI operations: **${routes.length}**.`, "",
    renderQuickReference(routes), "", ...routeSections,
    ...supplemental.flatMap((definition) => [renderSupplementalRoute(definition), ""]), END_MARKER,
  ].join("\n");
}
export function replaceGeneratedBlock(doc: string, generatedBlock: string): string {
  const start = doc.indexOf(START_MARKER); const end = doc.indexOf(END_MARKER);
  if (start === -1 || end === -1 || end < start) throw new Error(`Could not find a valid generated block in ${DOC_PATH}`);
  return `${doc.slice(0, start)}${generatedBlock}${doc.slice(end + END_MARKER.length)}`;
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
