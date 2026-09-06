import {
  CIRCUIT_OPEN_THRESHOLD,
  CIRCUIT_PROBE_INTERVAL_SEC,
  FEEDBACK_RATE_LIMIT_MAX_SUBMISSIONS,
  FEEDBACK_RATE_LIMIT_WINDOW_SEC,
} from "@shared/lib/ops-limits";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { THREAT_BAND_HEX } from "@shared/lib/classification";
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
import { STATUS_BLACKLIST_THRESHOLDS } from "@shared/lib/status-thresholds";
import { METHODOLOGY_MANIFEST } from "./methodology-manifest";

export interface DocContractBlock {
  readonly id: string;
  readonly file: string;
  readonly value: string;
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
    id: "status-blacklist-recent-stale-threshold",
    file: "docs/status-dashboard.md",
    value: String(STATUS_BLACKLIST_THRESHOLDS.missingRecentStale),
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
];

export function findDocContractDrift(
  readDocument: (file: string) => string,
): DocContractDrift[] {
  const documents = new Map<string, string>();
  const drift: DocContractDrift[] = [];

  for (const block of DOC_CONTRACT_BLOCKS) {
    const document = documents.get(block.file) ?? readDocument(block.file);
    documents.set(block.file, document);
    const expected = renderDocContractBlock(block);
    const start = document.indexOf(docContractStartMarker(block.id));
    const end = document.indexOf(docContractEndMarker(block.id), Math.max(0, start));
    const uniqueMarkers = document.indexOf(docContractStartMarker(block.id), start + 1) === -1
      && document.indexOf(docContractEndMarker(block.id)) === end
      && document.indexOf(docContractEndMarker(block.id), end + 1) === -1;
    const found = start >= 0 && end >= start && uniqueMarkers
      ? document.slice(start, end + docContractEndMarker(block.id).length)
      : null;
    if (found !== expected) drift.push({ file: block.file, id: block.id, expected, found });
  }

  return drift;
}
