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
 * longer matches any active stablecoin so stale entries surface instead of
 * being silently skipped.
 */
export const REVIEWED_LIVE_RESERVE_SOURCE_NOTES: Record<string, LiveReserveSourceQualityNote> = {
  "aa-falconx-mev-capital": {
    sourceUrl: "https://docs.pareto.credit/product/credit-vaults/live-vaults",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Pareto/RWA.xyz vault adapter if a public current NAV/composition endpoint is found",
    freshnessEvidence: "Static credit-vault description and RWA.xyz/Pareto links exist; no parsed current reserve timestamp is configured.",
    scoreGradePlausible: false,
    note: "Single credit-line exposure is useful for display only until a public machine-readable NAV/composition source with freshness is verified.",
  },
  "bfusd-binance": {
    sourceUrl: "https://www.binance.com/en/support/faq/detail/d62d25f330b94f5ba613c53e3c1ee8d0",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Binance publishes current composition/freshness data",
    freshnessEvidence: "Binance FAQ/product disclosures are self-reported and ad hoc.",
    scoreGradePlausible: false,
    note: "BFUSD is an internal Binance account product backed by an opaque collateral pool and hedging portfolio; no public source can validate a live reserve mix.",
  },
  "busd0-usual": {
    sourceUrl: "https://docs.usual.money/resources-and-ecosystem/fact-sheets/usual-products/busd0",
    sourceQuality: "independent",
    expectedAdapterFamily: "evm-branch-balances wrapper read with totalSupply reconciliation",
    freshnessEvidence: "Ethereum bUSD0 totalSupply and USD0 balanceOf(bUSD0) are read in the same on-chain run.",
    scoreGradePlausible: true,
    note: "bUSD0 is a locked-USD0 wrapper; the live config verifies the Ethereum wrapper holds matching USD0 against bUSD0 supply.",
  },
  "eursafo-spiko": {
    sourceUrl: "https://www.spiko.io/spiko-euro",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index if the page exposes dated PwC/fund documents consistently",
    freshnessEvidence: "Metadata records quarterly PwC/UCITS evidence, but no worker parser currently verifies a current EURSAFO document date.",
    scoreGradePlausible: false,
    note: "The fund source can plausibly validate the static one-bucket exposure, but it is not an independent live composition feed under current scoring policy.",
  },
  "moveusd-cfx": {
    sourceUrl: "https://docs.moveusd.com/docs/disclosures-disclaimers",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "single-asset or disclosure parser only after a current reserve/timestamp field is exposed",
    freshnessEvidence: "Public materials disclose 1:1 bank-deposit backing, but metadata notes no monthly attestation was found.",
    scoreGradePlausible: false,
    note: "A token supply/liveness probe would not independently verify bank deposits; score-grade use needs current reserve disclosure or attestation.",
  },
  "pc0000031-tradable": {
    sourceUrl: "https://app.tradable.xyz/investor/deals/861cce9e-08ae-45a0-aca8-9fa229a0189d",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Tradable exposes a public note/NAV API or dated report",
    freshnessEvidence: "Current metadata links a deal page and docs, but no public machine-readable current reserve composition or timestamp.",
    scoreGradePlausible: false,
    note: "The token is a KYC-gated private-credit note contract-priced at par; live reserve scoring would overstate source transparency.",
  },
  "pc0000033-tradable": {
    sourceUrl: "https://app.tradable.xyz/investor/deals/e2c78ce9-1c20-4f4a-b6ca-eba1b2f575b1",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Tradable exposes a public note/NAV API or dated report",
    freshnessEvidence: "Current metadata links a deal page and docs, but no public machine-readable current reserve composition or timestamp.",
    scoreGradePlausible: false,
    note: "The token is a KYC-gated private-credit note contract-priced at par; live reserve scoring would overstate source transparency.",
  },
  "safo-spiko-usd": {
    sourceUrl: "https://www.spiko.io/spiko-dollar",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index if the page exposes dated PwC/fund documents consistently",
    freshnessEvidence: "Metadata records quarterly PwC/UCITS evidence, but no worker parser currently verifies a current SAFO document date.",
    scoreGradePlausible: false,
    note: "The fund source can plausibly validate the static one-bucket exposure, but it is not an independent live composition feed under current scoring policy.",
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
  "acrdx-anemoy-apollo": {
    sourceUrl: "https://chroniclelabs.org/blog/chronicle-s-proof-of-asset-unlocks-apollo-s-acrdx-curated-by-steakhouse",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Chronicle proof-of-asset/Centrifuge adapter",
    freshnessEvidence: "Chronicle describes continuously refreshed Proof of Asset inputs, but no configured adapter currently verifies a public feed timestamp or composition split.",
    scoreGradePlausible: true,
    note: "The source is plausibly score-grade with a custom Chronicle adapter; it is not safe as a config-only addition today.",
  },
  "dusd-standx": {
    sourceUrl: "https://docs.standx.com/",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new StandX transparency/API adapter if a public reserve-ratio and composition endpoint is found",
    freshnessEvidence: "Public docs describe the delta-neutral backing model and reserve fund, but metadata has no proof-of-reserves or current composition timestamp.",
    scoreGradePlausible: false,
    note: "The backing is a CEX/custody-managed trading strategy; a display-only static mix should not be promoted without independent current position data.",
  },
  "eurspkcc-spiko": {
    sourceUrl: "https://www.spiko.io/spiko-cash-and-carry",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index if the page exposes dated PwC/fund documents consistently",
    freshnessEvidence: "Metadata records quarterly PwC/AMF fund evidence, but no worker parser currently verifies a current cash-and-carry document date.",
    scoreGradePlausible: false,
    note: "The source can support a reviewed static split, but the strategy bucket is not independently measured by a live composition feed under current scoring policy.",
  },
  "hbd-hive": {
    sourceUrl: "https://developers.hive.io/",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Hive chain-state adapter if protocol debt, HIVE market value, and conversion state are modeled together",
    freshnessEvidence: "Hive chain state can expose protocol-derived debt and conversion data, but the current metadata has no configured parser for HBD backing capacity or freshness.",
    scoreGradePlausible: true,
    note: "HBD is protocol-backed rather than reserve-asset backed; score-grade use is plausible only through a dedicated solvency/collateralization adapter.",
  },
  "mglobal-midas-fasanara": {
    sourceUrl: "https://midas.app/transparency",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Midas transparency parser only if independently verified current NAV/composition fields are public and stable",
    freshnessEvidence: "Metadata records daily self-reported NAV/proof materials, but no configured parser verifies a current composition timestamp.",
    scoreGradePlausible: false,
    note: "The Fasanara private-credit exposure remains curated until the transparency page exposes parseable independent evidence suitable for scoring.",
  },
  "msusd-metronome": {
    sourceUrl: "https://docs.metronome.io/metronome-synth/metronome-synth-protocol",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "new Metronome on-chain collateral adapter if vault positions and stablecoin exposures can be separated reliably",
    freshnessEvidence: "Protocol docs describe accepted collateral, but no configured source verifies the current multi-collateral mix or timestamp.",
    scoreGradePlausible: false,
    note: "The reserve mix includes direct stables plus yield and crypto positions; score-grade use needs current on-chain position attribution.",
  },
  "pc0000089-tradable": {
    sourceUrl: "https://app.tradable.xyz/investor/deals",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Tradable exposes a public note/NAV API or dated report",
    freshnessEvidence: "Current metadata links Tradable docs and deal context, but no public machine-readable current reserve composition or timestamp.",
    scoreGradePlausible: false,
    note: "The token is a KYC-gated private-credit note contract-priced at par; live reserve scoring would overstate source transparency.",
  },
  "pc0000101-tradable": {
    sourceUrl: "https://app.tradable.xyz/investor/deals",
    sourceQuality: "not-plausible",
    expectedAdapterFamily: "none until Tradable exposes a public note/NAV API or dated report",
    freshnessEvidence: "Current metadata links Tradable docs and deal context, but no public machine-readable current reserve composition or timestamp.",
    scoreGradePlausible: false,
    note: "The token is a KYC-gated legal-finance receivable exposure; live reserve scoring would overstate source transparency.",
  },
  "pmusd-precious-metals": {
    sourceUrl: "https://data.chain.link/feeds/ethereum/mainnet/ion-por",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "Chainlink proof-of-reserve feed plus liability reconciliation only if pmUSD supply and TokenBlender backing can be tied together",
    freshnessEvidence: "Metadata records a Chainlink/Instruxi proof source, but public feed state did not verify a current pmUSD-specific reserve/liability timestamp in this pass.",
    scoreGradePlausible: false,
    note: "The Chainlink source validates the referenced gold-claim backing, but score-grade use needs an end-to-end reserve/liability reconciliation.",
  },
  "sofid-sofi": {
    sourceUrl: "https://www.sofi.com/crypto/sofiusd/",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "none until SoFi publishes current attestations or an issuer reserve endpoint",
    freshnessEvidence: "Public product materials describe cash/cash-equivalent backing, but metadata has no proof-of-reserves or current attestation URL.",
    scoreGradePlausible: false,
    note: "Bank-account backing cannot be independently scored from product copy alone.",
  },
  "stac-securitize": {
    sourceUrl: "https://chroniclelabs.org/blog/chronicle-provides-proof-of-asset-verification-for-securitize-s-tokenized-aaa-clo-fund-bringing",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Chronicle proof-of-asset/NAV adapter",
    freshnessEvidence: "Chronicle describes continuous holdings, NAV, and pricing verification, but no configured adapter currently verifies a public feed timestamp or composition split.",
    scoreGradePlausible: true,
    note: "The source is plausibly score-grade with a custom Chronicle adapter; it is not safe as a config-only addition today.",
  },
  "susd-synthetix": {
    sourceUrl: "https://docs.synthetix.io/",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Synthetix on-chain collateral adapter if V2/V3 collateral pools and debt accounting can be reconciled",
    freshnessEvidence: "Protocol docs exist, but no configured source verifies current SNX, USDC, ETH/LST, and treasury-backed collateral weights.",
    scoreGradePlausible: true,
    note: "The backing spans legacy and V3 collateral systems; score-grade use is plausible only with current on-chain debt/collateral attribution.",
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
  "xdai-gnosis": {
    sourceUrl: "https://docs.gnosischain.com/about/tokens/",
    sourceQuality: "independent",
    expectedAdapterFamily: "new Gnosis native bridge adapter with USDS bridge balances and native xDAI debt reconciliation",
    freshnessEvidence: "Gnosis docs describe the native xDAI bridge model, but no configured adapter currently reconciles native supply to Ethereum-side USDS backing.",
    scoreGradePlausible: true,
    note: "xDAI is a plausible future score-grade wrapper candidate, but it needs a custom bridge/supply adapter before Safety Score can use live reserves.",
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
