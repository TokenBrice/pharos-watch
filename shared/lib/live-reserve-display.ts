import type {
  LiveReserveAdapterKey,
  LiveReserveEvidenceClass,
  ReserveDisplayBadgeKind,
  ReserveDisplayBadgeView,
} from "../types/live-reserves";

const ADAPTER_DISPLAY_BADGE_KINDS: Record<LiveReserveAdapterKey, ReserveDisplayBadgeKind> = {
  abracadabra: "live",
  accountable: "live",
  "anzen-usdz": "live",
  asymmetry: "live",
  btcfi: "live",
  "chainlink-nav": "live",
  "chainlink-por": "live",
  "circle-transparency": "live",
  "collateral-positions-api": "live",
  crvusd: "live",
  "curated-validated": "curated-validated",
  "dola-inverse": "live",
  "erc4626-single-asset": "live",
  ethena: "live",
  "evm-branch-balances": "live",
  falcon: "live",
  "fdusd-transparency": "live",
  frax: "curated-validated",
  "frax-balance-sheet": "live",
  fx: "live",
  gho: "live",
  infinifi: "live",
  lista: "live",
  "liquity-v1": "live",
  m0: "live",
  mento: "live",
  "openeden-usdo": "live",
  "re-metrics": "live",
  reservoir: "live",
  "sgforge-coinvertible": "live",
  "single-asset": "proof",
  "sky-makercore": "live",
  tether: "proof",
  "usdai-proof-of-reserves": "live",
  "usdd-data-platform": "live",
};

const RESERVE_DISPLAY_BADGE_LABELS: Record<ReserveDisplayBadgeKind, string> = {
  live: "Live",
  "curated-validated": "Curated-Validated",
  proof: "Proof",
};

export function getReserveDisplayBadgeKindForAdapter(
  adapterKey: LiveReserveAdapterKey,
): ReserveDisplayBadgeKind {
  return ADAPTER_DISPLAY_BADGE_KINDS[adapterKey];
}

function getReserveDisplayBadgeLabel(
  kind: ReserveDisplayBadgeKind,
): string {
  return RESERVE_DISPLAY_BADGE_LABELS[kind];
}

export function buildReserveDisplayBadge(
  kind: ReserveDisplayBadgeKind,
): ReserveDisplayBadgeView {
  return {
    kind,
    label: getReserveDisplayBadgeLabel(kind),
  };
}

export function inferReserveDisplayBadgeKindFromEvidenceClass(
  evidenceClass: LiveReserveEvidenceClass,
): ReserveDisplayBadgeKind {
  switch (evidenceClass) {
    case "independent":
      return "live";
    case "static-validated":
      return "curated-validated";
    case "weak-live-probe":
      return "proof";
    default:
      return "live";
  }
}

export function hasReserveDisplayBadgeForAdapter(
  adapterKey: string,
): adapterKey is LiveReserveAdapterKey {
  return Object.prototype.hasOwnProperty.call(ADAPTER_DISPLAY_BADGE_KINDS, adapterKey);
}
