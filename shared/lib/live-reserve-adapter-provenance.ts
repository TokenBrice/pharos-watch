import type { LiveReserveAdapterKey } from "../types/live-reserves";

export const LIVE_RESERVE_ADAPTER_STATUS_VALUES = ["active", "staged", "retired", "parked"] as const;

export type LiveReserveAdapterStatus = (typeof LIVE_RESERVE_ADAPTER_STATUS_VALUES)[number];

export interface LiveReserveAdapterProvenance {
  status: LiveReserveAdapterStatus;
  rationale: string;
  /** ISO date (YYYY-MM-DD) the adapter entered its current non-active status.
   *  Required for `parked` and `retired` entries so contributors can see how
   *  long the implementation has been carried unbound. */
  parkedSince?: string;
  /** ISO date (YYYY-MM-DD) by which the parked/retired adapter should be
   *  re-evaluated. Drives the sunset policy in docs/live-reserves.md. */
  nextReview?: string;
}

const ACTIVE_RATIONALE = "Bound by at least one active stablecoin liveReservesConfig.";

export const LIVE_RESERVE_ADAPTER_PROVENANCE = {
  abracadabra: { status: "active", rationale: ACTIVE_RATIONALE },
  accountable: { status: "active", rationale: ACTIVE_RATIONALE },
  "anzen-usdz": { status: "active", rationale: ACTIVE_RATIONALE },
  asymmetry: { status: "active", rationale: ACTIVE_RATIONALE },
  "attestation-pdf-index": { status: "active", rationale: ACTIVE_RATIONALE },
  "blast-usdb-yield-manager": { status: "active", rationale: ACTIVE_RATIONALE },
  btcfi: { status: "active", rationale: ACTIVE_RATIONALE },
  "buck-io-transparency": {
    status: "parked",
    rationale: "BUCK.fi transparency implementation is retained, but no tracked active coin currently binds it.",
    parkedSince: "2026-05-12",
    nextReview: "2026-11-12",
  },
  "cap-vault": { status: "active", rationale: ACTIVE_RATIONALE },
  "centrifuge-vault": {
    status: "parked",
    rationale: "Centrifuge vault implementation is retained, but tracked Anemoy/JTRSY coverage now uses Chainlink NAV.",
    parkedSince: "2026-05-12",
    nextReview: "2026-11-12",
  },
  "chainlink-nav": { status: "active", rationale: ACTIVE_RATIONALE },
  "chainlink-por": { status: "active", rationale: ACTIVE_RATIONALE },
  "circle-transparency": { status: "active", rationale: ACTIVE_RATIONALE },
  "collateral-positions-api": { status: "active", rationale: ACTIVE_RATIONALE },
  crvusd: { status: "active", rationale: ACTIVE_RATIONALE },
  "curated-validated": { status: "active", rationale: ACTIVE_RATIONALE },
  "dola-inverse": { status: "active", rationale: ACTIVE_RATIONALE },
  "erc4626-single-asset": { status: "active", rationale: ACTIVE_RATIONALE },
  ethena: { status: "active", rationale: ACTIVE_RATIONALE },
  "evm-branch-balances": { status: "active", rationale: ACTIVE_RATIONALE },
  falcon: { status: "active", rationale: ACTIVE_RATIONALE },
  "fdusd-transparency": { status: "active", rationale: ACTIVE_RATIONALE },
  "frax-balance-sheet": { status: "active", rationale: ACTIVE_RATIONALE },
  "frax-fpi-collateral": { status: "active", rationale: ACTIVE_RATIONALE },
  fx: { status: "active", rationale: ACTIVE_RATIONALE },
  gho: { status: "active", rationale: ACTIVE_RATIONALE },
  infinifi: { status: "active", rationale: ACTIVE_RATIONALE },
  jupusd: { status: "active", rationale: ACTIVE_RATIONALE },
  lista: { status: "active", rationale: ACTIVE_RATIONALE },
  "liquity-v1": { status: "active", rationale: ACTIVE_RATIONALE },
  "liquity-v2-branches": { status: "active", rationale: ACTIVE_RATIONALE },
  m0: { status: "active", rationale: ACTIVE_RATIONALE },
  mento: { status: "active", rationale: ACTIVE_RATIONALE },
  "nest-vault-positions": { status: "active", rationale: ACTIVE_RATIONALE },
  "openeden-usdo": { status: "active", rationale: ACTIVE_RATIONALE },
  "origin-vault-balances": { status: "active", rationale: ACTIVE_RATIONALE },
  "quantoz-transparency": { status: "active", rationale: ACTIVE_RATIONALE },
  "re-metrics": { status: "active", rationale: ACTIVE_RATIONALE },
  "resupply-pairs": { status: "active", rationale: ACTIVE_RATIONALE },
  "reserve-protocol-dtf": { status: "active", rationale: ACTIVE_RATIONALE },
  reservoir: { status: "active", rationale: ACTIVE_RATIONALE },
  "ripple-transparency": { status: "active", rationale: ACTIVE_RATIONALE },
  "river-protocol-info": { status: "active", rationale: ACTIVE_RATIONALE },
  "sgforge-coinvertible": { status: "active", rationale: ACTIVE_RATIONALE },
  "single-asset": { status: "active", rationale: ACTIVE_RATIONALE },
  "sky-makercore": { status: "active", rationale: ACTIVE_RATIONALE },
  "solstice-attestation": { status: "active", rationale: ACTIVE_RATIONALE },
  "superstate-liquidity": { status: "active", rationale: ACTIVE_RATIONALE },
  tether: {
    status: "parked",
    rationale:
      "Tether issuer summary adapter is retained, while current Tether assets use curated-validated or single-asset reserve probes.",
    parkedSince: "2026-05-12",
    nextReview: "2026-11-12",
  },
  "usdgo-transparency": { status: "active", rationale: ACTIVE_RATIONALE },
  "usdh-native-markets": { status: "active", rationale: ACTIVE_RATIONALE },
  "usdai-proof-of-reserves": { status: "active", rationale: ACTIVE_RATIONALE },
  "usd1-bundle-oracle": { status: "active", rationale: ACTIVE_RATIONALE },
  "usdd-data-platform": { status: "active", rationale: ACTIVE_RATIONALE },
  yamato: { status: "active", rationale: ACTIVE_RATIONALE },
  "zephyr-scanner": { status: "active", rationale: ACTIVE_RATIONALE },
} as const satisfies Record<LiveReserveAdapterKey, LiveReserveAdapterProvenance>;
