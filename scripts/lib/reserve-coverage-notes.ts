export type LiveReserveSourceQuality =
  | "independent"
  | "static-validated"
  | "weak-proof"
  | "not-plausible"
  | "unreviewed";

export interface LiveReserveSourceQualityNote {
  sourceUrl: string | null;
  sourceQuality: LiveReserveSourceQuality;
  expectedAdapterFamily: string;
  freshnessEvidence: string;
  scoreGradePlausible: boolean;
  note: string;
}

/**
 * Per-coin source-quality review notes for curated-only reserve candidates.
 * Keyed by stablecoin id; keys must stay in sync with the active registry.
 * generate-reserve-coverage-audit.ts warns at run time when a key here no
 * longer matches any active stablecoin (the coin is gone or frozen), and a
 * second warning class fires when the coin is now live-configured — both stale
 * classes surface instead of being silently skipped, so the note can be
 * deleted.
 */
export const REVIEWED_LIVE_RESERVE_SOURCE_NOTES: Record<string, LiveReserveSourceQualityNote> = {
  "moveusd-cfx": {
    sourceUrl: "https://docs.moveusd.com/docs/disclosures-disclaimers",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "single-asset or disclosure parser only after a current reserve/timestamp field is exposed",
    freshnessEvidence: "Public materials disclose 1:1 bank-deposit backing, but metadata notes no monthly attestation was found.",
    scoreGradePlausible: false,
    note: "A token supply/liveness probe would not independently verify bank deposits; score-grade use needs current reserve disclosure or attestation.",
  },
  "usda-avalon": {
    sourceUrl: "https://docs.avalonfinance.xyz",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Avalon collateral API/parser if current collateral balances and timestamps are published",
    freshnessEvidence: "DefiLlama supply and issuer docs exist, but current public metadata does not include a parsed live collateral mix timestamp.",
    scoreGradePlausible: false,
    note: "The curated BTC/USDT/LST reserve mix cannot become score-grade without a current independent composition source.",
  },
  "usdf-astherus": {
    sourceUrl: "https://www.asterdex.com/en/usdf",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Astherus/Aster collateral API parser if a current composition endpoint is published",
    freshnessEvidence: "Current metadata describes Ceffu/MirrorX and delta-neutral backing, but no public current composition/timestamp endpoint is configured.",
    scoreGradePlausible: false,
    note: "The USDT plus delta-neutral strategy mix remains curated until the issuer exposes current, parseable reserve data.",
  },
  "msusd-metronome": {
    sourceUrl: "https://docs.metronome.io/metronome-synth/metronome-synth-protocol",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Metronome on-chain collateral adapter if vault positions and stablecoin exposures can be separated reliably",
    freshnessEvidence: "Protocol docs describe accepted collateral, but no configured source verifies the current multi-collateral mix or timestamp.",
    scoreGradePlausible: false,
    note: "The reserve mix includes direct stables plus yield and crypto positions; score-grade use needs current on-chain position attribution.",
  },
  "pmusd-precious-metals": {
    sourceUrl: "https://data.chain.link/feeds/ethereum/mainnet/ion-por",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "Chainlink proof-of-reserve feed plus liability reconciliation only if pmUSD supply and TokenBlender backing can be tied together",
    freshnessEvidence: "Metadata records a Chainlink/Instruxi proof source, but public feed state did not verify a current pmUSD-specific reserve/liability timestamp in this pass.",
    scoreGradePlausible: false,
    note: "The Chainlink source validates the referenced gold-claim backing, but score-grade use needs an end-to-end reserve/liability reconciliation.",
  },
  "usdkg-gold-dollar": {
    sourceUrl: "https://www.usdkg.com/transparency",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index if current Kreston reserve reports are consistently published with parseable dates",
    freshnessEvidence: "Metadata records quarterly Kreston proof-of-reserve evidence, but no worker parser currently verifies a current report date.",
    scoreGradePlausible: false,
    note: "The audited gold backing supports static validation, but it is not a live independent composition feed under current scoring policy.",
  },
  "usdsui-sui": {
    sourceUrl: "https://apidocs.bridge.xyz/platform/issuance/reserve-management",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "Bridge attestation/API parser only if current reserve attestations become publicly parseable",
    freshnessEvidence: "Bridge docs describe reserve management and quarterly third-party audits, but metadata has no current public attestation parser.",
    scoreGradePlausible: false,
    note: "The Bridge-issued reserve model is credible for static display, but score-grade use needs a current public reserve report or API source.",
  },
  "usp-pikudao": {
    sourceUrl: "https://docs.piku.co/piku",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Piku strategy parser only if current strategy allocations and stablecoin buffers become public and timestamped",
    freshnessEvidence: "Docs describe the reserve strategy, but no configured source verifies the current BMMF, DeFi, or cash-stablecoin mix.",
    scoreGradePlausible: false,
    note: "The backing is dominated by opaque strategy buckets; only the small stablecoin buffers are directly linkable today.",
  },
  "xtusd-xt": {
    sourceUrl: "https://www.xt.com/",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until XT.com publishes independent current reserve composition data",
    freshnessEvidence: "Public issuer materials are insufficient to verify the current managed reserve pool.",
    scoreGradePlausible: false,
    note: "An exchange-managed opaque reserve pool should remain curated-only until independently measured reserve data is available.",
  },
  "buidl-blackrock": {
    sourceUrl: "https://securitize.io/blackrock/buidl",
    sourceQuality: "independent",
    expectedAdapterFamily: "chainlink-nav (implemented; live config suspended after the BUIDL NAV feed was delisted)",
    freshnessEvidence:
      "The Chainlink BUIDL NAV feed (0x6B3A1CFFD3136cfF5C49F3379A4Da721Bc4f5d68) stopped updating 2026-06-23 and was removed from data.chain.link and the Chainlink reference-data directory; Securitize exposes no public NAV/AUM API as of 2026-07-09.",
    scoreGradePlausible: true,
    note: "Feed retired upstream, temporarily curated-only: the on-chain NAV oracle froze at 1.00 on 2026-06-23 and is delisted, so every sync degrades on oracle staleness with no recovery path. The chainlink-nav adapter is retained (18 other coins); restore liveReservesConfig if Chainlink relists a BUIDL NAVLink feed (sibling Securitize funds VBILL/ACRED still have live feeds) or Securitize publishes a machine-readable NAV source.",
  },
  "usdo-openeden": {
    sourceUrl: "https://openeden.com/usdo/transparency",
    sourceQuality: "independent",
    expectedAdapterFamily: "openeden-usdo (implemented; live config suspended pending issuer egress allowlist)",
    freshnessEvidence:
      "OpenEden's issuer API (prod-gw.openeden.com) publishes dated reserve composition and the openeden-usdo adapter verified it through 2026-06-10; the endpoint stays healthy for ordinary clients with a valid TLS chain.",
    scoreGradePlausible: true,
    note: "Genuine independent live feed, temporarily curated-only: OpenEden's AWS/APISIX gateway began dropping Cloudflare Worker egress (~2026-06-10), so every sync fails at the network layer before any HTTP response while the source itself stays reachable. The openeden-usdo adapter is retained; restore liveReservesConfig to re-enable once OpenEden allowlists our Worker egress (Cloudflare ASN AS13335).",
  },
};

export const DEFAULT_SOURCE_QUALITY_NOTE: LiveReserveSourceQualityNote = {
  sourceUrl: null,
  sourceQuality: "unreviewed",
  expectedAdapterFamily: "unreviewed",
  freshnessEvidence: "Not reviewed in this source-quality pass.",
  scoreGradePlausible: false,
  note: "No source-quality note has been recorded yet.",
};
