import {
  CIRCUIT_OPEN_THRESHOLD,
  CIRCUIT_PROBE_INTERVAL_SEC,
  FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
  FEEDBACK_RATE_LIMIT_WINDOW_SEC,
} from "@shared/lib/ops-limits";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import { DATA_SURFACE_DESCRIPTORS } from "@shared/lib/data-surface-descriptors";
import { getPublicProducerGraceBudget, MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO, PUBLIC_PRODUCER_INTERVAL_SEC } from "@shared/lib/public-health";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
import { CEMETERY_RECORDED_AT_DESCRIPTION } from "@shared/lib/cemetery-merged";
import {
  DEPEG_CONFIRMATION_SUPPLY_THRESHOLD,
  DEPEG_EXTREME_MOVE_BPS,
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
  DEPEG_PRIMARY_PRICE_MAX_AGE_SEC,
  DEPEG_SECONDARY_THRESHOLD_RATIO,
  DEPEG_THRESHOLD_BPS,
  DEPEG_THRESHOLD_BPS_NON_USD,
  DEX_FRESHNESS_SEC,
  DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD,
} from "@shared/lib/depeg-config";
import { DEWS_SIGNAL_WEIGHTS, DEWS_THREAT_BANDS } from "@shared/lib/dews-config";
import {
  DURABILITY_COMPONENT_WEIGHTS,
  LIQUIDITY_SCORE_WEIGHTS,
} from "@shared/lib/liquidity-score-weights";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { FRESHNESS_RATIOS, getCacheHealthyMaxRatio, getCacheRatioThresholds, STATUS_BLACKLIST_THRESHOLDS } from "@shared/lib/status-thresholds";
import { METHODOLOGY_MANIFEST } from "./methodology-manifest";
import { read } from "./shared";
import { assignmentKey, buildAssignmentMap, parseAssignments } from "../wrangler-toml.mjs";

export interface DocContractBlock {
  readonly id: string;
  readonly file: string;
  readonly value: string;
}

export interface DocContractRegion {
  readonly id: string;
  readonly file: string;
  readonly startMarker: string;
  readonly endMarker: string;
  readonly expected: string;
}

export interface DocContractDrift {
  readonly file: string;
  readonly id: string;
  readonly expected: string;
  readonly found: string | null;
}

export function docContractStartMarker(id: string): string {
  return `<!-- GENERATED-START: ${id} -->`;
}

export function docContractEndMarker(id: string): string {
  return `<!-- GENERATED-END: ${id} -->`;
}

export function renderDocContractBlock(block: DocContractBlock): string {
  return `${docContractStartMarker(block.id)}${block.value}${docContractEndMarker(block.id)}`;
}

function percentage(fraction: number): string {
  return `${fraction * 100}%`;
}

function minutes(seconds: number): string {
  return `${seconds} (${seconds / 60} min)`;
}

function bps(basisPoints: number): string {
  return `${basisPoints} (${basisPoints / 100}%)`;
}

function integer(value: number): string {
  return value.toLocaleString("en-US");
}

const methodologyBlocks: readonly DocContractBlock[] = METHODOLOGY_MANIFEST.map((entry) => ({
  id: `methodology-version-${entry.key}`,
  file: entry.doc,
  value: `\`${entry.expectedLabel}\``,
}));

const reportCardBlocks: readonly DocContractBlock[] = [
  {
    id: "report-cards-active-model",
    file: "docs/report-cards.md",
    value: `\`v${SAFETY_SCORE_METHODOLOGY_VERSION.split(".")[0]}\``,
  },
  ...Object.entries(V9_CANDIDATE_POLICY_V1.policy.semantic.formula.pillarWeights).map(([pillar, weight]) => ({
    id: `report-cards-${pillar}-pillar-weight`,
    file: "docs/report-cards.md",
    value: percentage(weight),
  })),
];

const depegBlocks: readonly DocContractBlock[] = [
  ["depeg-threshold-usd", bps(DEPEG_THRESHOLD_BPS)],
  ["depeg-threshold-non-usd", bps(DEPEG_THRESHOLD_BPS_NON_USD)],
  ["depeg-confirmation-supply", `$${integer(DEPEG_CONFIRMATION_SUPPLY_THRESHOLD)}`],
  ["depeg-pending-min-age", minutes(DEPEG_PENDING_MIN_AGE_SEC)],
  ["depeg-pending-expiry", minutes(DEPEG_PENDING_EXPIRY_SEC)],
  ["depeg-secondary-threshold-ratio", DEPEG_SECONDARY_THRESHOLD_RATIO.toFixed(1)],
  ["depeg-primary-price-max-age", minutes(DEPEG_PRIMARY_PRICE_MAX_AGE_SEC)],
  ["depeg-extreme-move", bps(DEPEG_EXTREME_MOVE_BPS)],
  ["depeg-dex-freshness", minutes(DEX_FRESHNESS_SEC)],
  ["depeg-dex-min-tvl", integer(DEX_PRICE_CHECK_DEPEG_MIN_TVL_USD)],
].map(([id, value]) => ({ id, file: "docs/depeg-detection.md", value }));

const dewsSignalBlocks: readonly DocContractBlock[] = Object.entries(DEWS_SIGNAL_WEIGHTS).map(([key, weight]) => ({
  id: `dews-${key}-weight`,
  file: "docs/dews.md",
  value: weight.toFixed(2),
}));

let threatBandLower = 0;
const dewsThreatBandBlocks: DocContractBlock[] = [];
for (const band of DEWS_THREAT_BANDS) {
  const range = band.upper === 100 ? `${threatBandLower}-100` : `${threatBandLower}-${band.upper}`;
  dewsThreatBandBlocks.push(
    { id: `dews-${band.band.toLowerCase()}-range`, file: "docs/dews.md", value: range },
    { id: `dews-${band.band.toLowerCase()}-label`, file: "docs/dews.md", value: `**${band.band}**` },
    { id: `dews-${band.band.toLowerCase()}-hex`, file: "docs/dews.md", value: `\`${THREAT_BAND_HEX[band.band]}\`` },
  );
  threatBandLower = band.upper + 1;
}

const liquidityBlocks: readonly DocContractBlock[] = [
  ...LIQUIDITY_SCORE_WEIGHTS.map((component) => ({
    id: `liquidity-${component.key}-weight`,
    file: "docs/dex-liquidity.md",
    value: percentage(component.weight),
  })),
  ...Object.entries(DURABILITY_COMPONENT_WEIGHTS).map(([component, weight]) => ({
    id: `liquidity-durability-${component}-weight`,
    file: "docs/dex-liquidity.md",
    value: percentage(weight),
  })),
];

const workerLimitBlocks: readonly DocContractBlock[] = [
  {
    id: "worker-feedback-rate-limit",
    file: "docs/worker-and-api-limits.md",
    value: `\`${FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS} submissions / ${FEEDBACK_RATE_LIMIT_WINDOW_SEC / 60} minutes\` per salted IP hash`,
  },
  {
    id: "worker-circuit-breaker-limit",
    file: "docs/worker-and-api-limits.md",
    value: `opens after \`${CIRCUIT_OPEN_THRESHOLD}\` consecutive failures, probes every \`${CIRCUIT_PROBE_INTERVAL_SEC / 60} minutes\``,
  },
];

const apiMetaBlocks: readonly DocContractBlock[] = [
  ["stablecoins", API_FRESHNESS_MAX_AGE_SEC.stablecoins],
  ["chains", API_FRESHNESS_MAX_AGE_SEC.chains],
  ["bluechip-ratings", API_FRESHNESS_MAX_AGE_SEC.bluechip],
  ["usds-status", API_FRESHNESS_MAX_AGE_SEC.usdsStatus],
  ["yield-rankings", API_FRESHNESS_MAX_AGE_SEC.yieldRankings],
].map(([route, value]) => ({
  id: `api-meta-${route}-max-age`,
  file: "docs/api-reference.md",
  value: String(value),
}));

const statusBlocks: readonly DocContractBlock[] = [
  {
    id: "status-blacklist-recent-watch-threshold",
    file: "docs/status-dashboard.md",
    value: String(STATUS_BLACKLIST_THRESHOLDS.missingRecentWatch),
  },
];

const hours = (sec: number) => `${sec / 3_600}h`;
const shortMinutes = (sec: number) => `${sec / 60}m`;
const yieldBands = getCacheRatioThresholds("yield-data");
const yieldBudget = DATA_SURFACE_DESCRIPTORS.yieldRankings.endpointMaxAgeSec;
const safetyInterval = CRON_INTERVALS["compute-safety-score-v9"];
const consumerBudget = hours(2 * safetyInterval);
const safetyEndpointSec = DATA_SURFACE_DESCRIPTORS.reportCards.endpointMaxAgeSec;
const mintBurnEndpointSec = API_FRESHNESS_MAX_AGE_SEC.mintBurnFlows;
const mintBurnProducer = getPublicProducerGraceBudget(PUBLIC_PRODUCER_INTERVAL_SEC.mintBurn);
const safetyProducer = getPublicProducerGraceBudget(PUBLIC_PRODUCER_INTERVAL_SEC.safetyScores);

const freshnessBlocks: readonly DocContractBlock[] = [
  {
    id: "yield-publication-freshness-bands",
    file: "docs/yield-intelligence.md",
    value: `fresh through ${integer(yieldBudget * yieldBands.degraded)} seconds, degraded through ${integer(yieldBudget * yieldBands.stale)} seconds, then stale.`,
  },
  {
    id: "status-yield-cache-ratios",
    file: "docs/status-dashboard.md",
    value: `\`>${yieldBands.degraded}x\` degraded / \`>${yieldBands.stale}x\` stale`,
  },
  {
    id: "status-yield-healthy-max-ratio",
    file: "docs/status-dashboard.md",
    value: `\`healthyMaxRatio\` is \`${FRESHNESS_RATIOS.DEGRADED}\` by default and \`${getCacheHealthyMaxRatio("yield-data")}\` for \`yield-data\``,
  },
  {
    id: "status-safety-cadence",
    file: "docs/status-dashboard.md",
    value: `(${integer(safetyInterval)}-second cadence)`,
  },
  {
    id: "flow-safety-consumer-budget",
    file: "docs/data-flow-map.md",
    value: `past the ${consumerBudget} consumer budget`,
  },
  {
    id: "flow-safety-endpoint-band",
    file: "docs/data-flow-map.md",
    value: `(${FRESHNESS_RATIOS.DEGRADED}× the ${hours(safetyEndpointSec)} endpoint budget, ${hours(FRESHNESS_RATIOS.DEGRADED * safetyEndpointSec)})`,
  },
  {
    id: "detail-safety-consumer-budget",
    file: "docs/stablecoin-detail-page.md",
    value: `${consumerBudget} consumer budget`,
  },
  {
    id: "dependency-safety-polling",
    file: "docs/dependency-map.md",
    value: `${safetyInterval / 60}-minute \`staleTime\` and ${(2 * safetyInterval) / 60}-minute \`refetchInterval\`.`,
  },
  {
    id: "status-mint-burn-public-freshness",
    file: "docs/status-dashboard.md",
    value: `fresh through ${hours(mintBurnEndpointSec)} and degraded through ${hours(mintBurnEndpointSec * MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO)}. `
      + `Public producer status is Delayed after ${shortMinutes(mintBurnProducer.delayedAfterSec)}, Degraded after ${hours(mintBurnProducer.degradedAfterSec)} and outage after ${hours(mintBurnProducer.outageAfterSec)}.`,
  },
  {
    id: "status-mint-burn-sync-window",
    file: "docs/status-dashboard.md",
    value: `keys off the critical-lane sync age against a \`${shortMinutes(mintBurnEndpointSec)}\` window (\`${mintBurnEndpointSec / PUBLIC_PRODUCER_INTERVAL_SEC.mintBurn} * expectedIntervalSec\`): \`fresh\` ≤ \`${shortMinutes(mintBurnEndpointSec)}\`, \`degraded\` ≤ \`${shortMinutes(mintBurnEndpointSec * MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO)}\` (${MINT_BURN_PUBLIC_FRESHNESS_DEGRADED_RATIO}x), \`stale\` beyond.`,
  },
  {
    id: "status-safety-raw-stale-public-outage",
    file: "docs/status-dashboard.md",
    value: `the shared Safety Score publication floor is \`stale\` (raw stale starts beyond ${safetyProducer.degradedAfterSec / PUBLIC_PRODUCER_INTERVAL_SEC.safetyScores} producer intervals, ${hours(safetyProducer.degradedAfterSec)}; public Safety outage starts beyond ${safetyProducer.outageAfterSec / PUBLIC_PRODUCER_INTERVAL_SEC.safetyScores} intervals, ${hours(safetyProducer.outageAfterSec)})`,
  },
];

export const DOC_CONTRACT_BLOCKS: readonly DocContractBlock[] = [
  ...methodologyBlocks,
  ...reportCardBlocks,
  ...depegBlocks,
  ...dewsSignalBlocks,
  ...dewsThreatBandBlocks,
  ...liquidityBlocks,
  ...workerLimitBlocks,
  ...apiMetaBlocks,
  ...statusBlocks,
  ...freshnessBlocks,
  {
    id: "pricing-aggregate-dex-suppression",
    file: "docs/pricing-pipeline.md",
    value: "the aggregate is withheld once an overlapping protocol candidate passes registry, freshness, price and TVL checks, even when every lane then fails corroboration.",
  },
  {
    id: "depeg-confirm-required-direction",
    file: "docs/depeg-detection.md",
    value: "`confirm_required` direction changes keep the old-direction lifecycle open",
  },
  {
    id: "cemetery-recorded-at-description",
    file: "docs/cemetery-and-compare.md",
    value: CEMETERY_RECORDED_AT_DESCRIPTION,
  },
];

/** The example selects the shared runtime controls, not routes, secrets or bindings. */
function renderWorkerRuntimeSnippet(toml: string): string {
  const assignments = parseAssignments(toml);
  const config = buildAssignmentMap(assignments);
  const field = (section: string, key: string) => {
    const value = config.get(assignmentKey(section, key));
    if (value === undefined) throw new Error(`worker/wrangler.toml: missing runtime configuration ${section}.${key}`);
    return `${key.startsWith("#") ? JSON.stringify(key) : key} = ${value}`;
  };
  const rules = assignments.filter(({ section }) => section === "rules");
  const textStart = rules.findIndex(({ key, value }) => key === "type" && value === '"Text"');
  if (textStart < 0) throw new Error("worker/wrangler.toml: missing Text module rule");
  const textEnd = rules.findIndex(({ key }, index) => index > textStart && key === "type");
  const textRule = rules.slice(textStart, textEnd < 0 ? undefined : textEnd);
  return [
    "\n```toml",
    ...["compatibility_date", "compatibility_flags", "preview_urls", "minify", "keep_names", "upload_source_maps"].map((key) => field("root", key)),
    "", "[alias]", field("alias", "#pharos-full-catalog"),
    "", "[[rules]]", ...textRule.map(({ key, value }) => `${key} = ${value}`),
    "", "[limits]", field("limits", "cpu_ms"),
    "", "[observability]", field("observability", "enabled"), field("observability", "head_sampling_rate"),
    "", "[observability.logs]", field("observability.logs", "enabled"), field("observability.logs", "invocation_logs"),
    "```\n",
  ].join("\n");
}

export function getDocContractRegions(readDocument: typeof read = read): DocContractRegion[] {
  return [...DOC_CONTRACT_BLOCKS, {
    id: "worker-runtime-limits",
    file: "docs/worker-infrastructure.md",
    value: renderWorkerRuntimeSnippet(readDocument("worker/wrangler.toml")),
  }].map((block) => ({
    id: block.id,
    file: block.file,
    startMarker: docContractStartMarker(block.id),
    endMarker: docContractEndMarker(block.id),
    expected: renderDocContractBlock(block),
  }));
}

export function findDocContractDrift(
  readDocument: (file: string) => string,
  regions: readonly DocContractRegion[] = getDocContractRegions(readDocument),
): DocContractDrift[] {
  const documents = new Map<string, string>();
  const drift: DocContractDrift[] = [];

  for (const region of regions) {
    const document = documents.get(region.file) ?? readDocument(region.file);
    documents.set(region.file, document);
    const start = document.indexOf(region.startMarker);
    const end = document.indexOf(region.endMarker, Math.max(0, start));
    const uniqueMarkers = document.indexOf(region.startMarker, start + 1) === -1
      && document.indexOf(region.endMarker) === end
      && document.indexOf(region.endMarker, end + 1) === -1;
    const found = start >= 0 && end >= start && uniqueMarkers
      ? document.slice(start, end + region.endMarker.length)
      : null;
    if (found !== region.expected) {
      drift.push({ file: region.file, id: region.id, expected: region.expected, found });
    }
  }

  return drift;
}

export function replaceDocContractRegions(document: string, regions: readonly DocContractRegion[]): string {
  const drift = findDocContractDrift(() => document, regions);
  for (const region of drift) {
    if (region.found === null) throw new Error(`${region.file}: expected exactly one complete ${region.id} block`);
    document = document.replace(region.found, () => region.expected);
  }
  return document;
}
