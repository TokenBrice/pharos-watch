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
  "attestation-pdf-index": "curated-validated",
  "blast-usdb-yield-manager": "live",
  btcfi: "live",
  "cap-vault": "live",
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
  "frax-balance-sheet": "live",
  "frax-fpi-collateral": "live",
  fx: "live",
  gho: "live",
  infinifi: "live",
  jupusd: "live",
  lista: "live",
  "liquity-v1": "live",
  "liquity-native-active-pool": "live",
  "liquity-v2-branches": "live",
  m0: "live",
  "m0-wrapper-underlying": "live",
  mento: "live",
  "nest-vault-positions": "live",
  "openeden-usdo": "live",
  "origin-vault-balances": "live",
  "quantoz-transparency": "live",
  "re-metrics": "live",
  "resupply-pairs": "live",
  "reserve-protocol-dtf": "live",
  reservoir: "live",
  "ripple-transparency": "live",
  "sgforge-coinvertible": "live",
  "sgho-wrapper": "live",
  "solstice-attestation": "proof",
  "single-asset": "proof",
  "sky-makercore": "live",
  "superstate-liquidity": "live",
  "river-protocol-info": "proof",
  "usdgo-transparency": "proof",
  "usdh-native-markets": "proof",
  "usdai-proof-of-reserves": "live",
  "usd1-bundle-oracle": "live",
  "usdd-data-platform": "live",
  yamato: "live",
  "zephyr-scanner": "proof",
};

const RESERVE_DISPLAY_BADGE_LABELS: Record<ReserveDisplayBadgeKind, string> = {
  live: "Live",
  "curated-validated": "Curated-Validated",
  proof: "Proof",
};

export function getReserveDisplayBadgeKindForAdapter(adapterKey: LiveReserveAdapterKey): ReserveDisplayBadgeKind {
  return ADAPTER_DISPLAY_BADGE_KINDS[adapterKey];
}

function getReserveDisplayBadgeLabel(kind: ReserveDisplayBadgeKind): string {
  return RESERVE_DISPLAY_BADGE_LABELS[kind];
}

export function buildReserveDisplayBadge(kind: ReserveDisplayBadgeKind): ReserveDisplayBadgeView {
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

export function hasReserveDisplayBadgeForAdapter(adapterKey: string): adapterKey is LiveReserveAdapterKey {
  return Object.prototype.hasOwnProperty.call(ADAPTER_DISPLAY_BADGE_KINDS, adapterKey);
}
