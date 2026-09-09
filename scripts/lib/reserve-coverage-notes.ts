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
  "usdh-hubble": {
    sourceUrl: "https://hubbleprotocol.io/",
    sourceQuality: "unreviewed",
    expectedAdapterFamily: "Solana borrowing-market account decoder after a complete collateral census",
    freshnessEvidence: "Reviewed 2026-09-09: prior attestations are gone; Hubble borrowing-market Borsh layout decoding has not started.",
    scoreGradePlausible: false,
    note: "Deferred, not a weak supply-probe substitute. Reopen only after verified program/account identities, complete collateral layouts and custody balances, prices, and USDH liability reconciliation are established.",
  },
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
  "usdo-openeden": {
    sourceUrl: "https://openeden.com/usdo/transparency",
    sourceQuality: "independent",
    expectedAdapterFamily: "openeden-usdo (implemented; live config suspended pending issuer egress allowlist)",
    freshnessEvidence:
      "OpenEden's issuer API (prod-gw.openeden.com) publishes dated reserve composition and the openeden-usdo adapter verified it through 2026-06-10; the endpoint stays healthy for ordinary clients with a valid TLS chain.",
    scoreGradePlausible: true,
    note: "Genuine independent live feed, temporarily curated-only: OpenEden's AWS/APISIX gateway began dropping Cloudflare Worker egress (~2026-06-10), so every sync fails at the network layer before any HTTP response while the source itself stays reachable. The openeden-usdo adapter is retained; restore liveReservesConfig to re-enable once OpenEden allowlists our Worker egress (Cloudflare ASN AS13335).",
  },
  "buck-bucket-protocol": {
    sourceUrl: "https://graphql.mainnet.sui.io/graphql",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "buck-sui-graphql (not bound; checkpoint transport implemented)",
    freshnessEvidence: "Reviewed 2026-09-09: live pinned checkpoint 320690710 (2026-09-09T19:08:46.811Z) exposes the protocol TreasuryCap and complete root dynamic-field census; latest-state reads can carry checkpoint evidence, not issuer timestamps.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. BUCK remains unbound: V1 Reservoir BUCKETUS and BLUEFIN_STABLE_LP hold positive balances (1937877335613590 and 282087505173162 raw units), but DefiLlama returns no prices for either token, nor CETABLE/SCABLE/STAPEARL. LP face amounts and fixed conversion rates do not establish non-circular underlying reserve value. The reviewed LP group was 91.79% of the dated V1 envelope; its BUCK component remains unresolved, so neither total reserves nor unknown USD exposure can be honestly quantified. V2 CDP/PSM assets back USDB, not BUCK; a partial bottle/tank census or weak label cannot repair this valuation gap. No ratio or reserve adapter is published.",
  },
  "alusd-alchemix": {
    sourceUrl: "https://alchemix-finance.gitbook.io/user-docs/alchemix-ecosystem/alchemix-on-l2",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "alchemix-alchemist (promotion deferred; complete controller, transmuter and AMO census required)",
    freshnessEvidence: "Reviewed 2026-09-09: Ethereum block 25941797, timestamp 2026-09-09T19:06:23Z, pins 14 yield-token share conversions and the current TransmuterBuffer; these are independent selected-position observations, not a complete reserve feed.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. Keep curated-validated; do not bind a partial independent adapter. All 14 Ethereum AlchemistV2 yield tokens convert totalShares through convertSharesToUnderlyingTokens into DAI, USDC, USDT or FRAX. Buffer 0x1eed2dbeb9fc23ab483f447f38f289ca15f79bac routes four transmuters, but its amos mappings are zero while the documented Elixir 0x9735f7d3ea56b454b24ffd74c58e9bd85cfad31b still holds a nonzero LP position. Current routing therefore cannot prove the historical AMO custody census. The AlToken minter whitelist is a non-enumerable mapping and setWhitelist emits no event. Official documentation also permits native Optimism/Arbitrum debt and L2 AMO multisigs. Missing: reconciled controller/legacy-AMO/multisig and bridge census, net alUSD holdings, and supported valuation of every material position against the matching liability universe. expectedValue is not a realizable-value substitute; adding buffered deposits to controller shares can double count. No asset-wide unknown-exposure percentage or collateralization ratio is asserted.",
  },
  "scusd-rings": {
    sourceUrl: "https://api.veda.tech",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "veda-boringvault (not built; gated API + non-4626 BoringVault enumeration required)",
    freshnessEvidence: "Reviewed 2026-09-09: api.veda.tech still returns 401 Unauthorized (re-probed). scUSD (Sonic 0xd3dce716f3ef535c5ff8d041c1a41c3bd89b97ae) totalSupply() returns ~648,816.9 (6 decimals) but its ERC-4626 totalAssets() reverts.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. scUSD stays unbound: the Veda API is auth-gated (401) and the underlying Veda BoringVault is a non-4626 surface whose multi-strategy positions (accountant plus Aave/Morpho-style strategy TVLs) cannot be enumerated from bare ERC-20 balanceOf reads, which omit deployed strategy positions. The sidecar correctly stays 100% unknown (basket-needs-split). Do not bind until Veda opens the API or a reviewed BoringVault position-reader adapter exists; a single-asset supply probe would only add weak display coverage.",
  },
  "pht-pht": {
    sourceUrl: "https://apilist.tronscanapi.com/api/account?address=TCRjE31cgksHetFLQd6JENAfBfXhHjMEFU",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "tron-escrow-balance (not bound; incomplete multi-ilk CDP census)",
    freshnessEvidence: "Reviewed 2026-09-09: TronGrid block 86102973 (2026-09-09T19:08:21Z) reads the escrow USDT balance 800,002.000009 and PHT totalSupply 44,489,605 PHT via triggerconstantcontract; latest-state reads can carry block evidence.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. Keep curated-only; do not bind the Tron escrow as an independent single-bucket reserve. The escrow TCRjE31cgksHetFLQd6JENAfBfXhHjMEFU holds 800,002 USDT, which roughly reconciles to the Tron PHT leg (44,489,605 PHT, ~$715k at the ~$0.016 PHP peg) but covers only ~20% of the reviewed supply: DefiLlama reports 225,011,900 PHT and Ethereum totalSupply() reads 225,011,899, with Polygon (11,984,287) and Tron (44,489,605) bridged deployments on top. The issuer's 'all existing PHT minted with apcxUSDT backed 1:1 by USDT at the escrow' claim is contradicted by the live Ethereum Vat, whose five ilks (USDT-A, cPHP-A, ApcxUSDT-A, demoUSDT-A, USDC-A) carry positive normalized debt with no published branch-level collateral balances or reconciliation (the disclosed ILK conflict). PHT is PHP-pegged, so a raw USDT/PHT ratio (~0.018) is the PHP/USD FX rate rather than a collateralization ratio; a complete same-block census across the three OFT deployments with a supported valuation path for every ilk is required before any independent binding.",
  },
  "krw1-bdacs": {
    sourceUrl: "https://krw1.kr/transparency",
    sourceQuality: "static-validated",
    expectedAdapterFamily: "attestation-pdf-index (not bound; dated-report index required)",
    freshnessEvidence: "Reviewed 2026-09-09: krw1.kr/transparency publishes a Live issue/reserve counter (issueAmount 23,298,779 vs reserveAmount 23,798,779 KRW) plus a monthly CPA report index, but the sole CPA PDF link is https://krw1.s3.ap-northeast-2.amazonaws.com/document/cpa/1786350512424.pdf — an epoch-millisecond filename (2026-08-10 upload) whose anchor text is a bare month label 'Jul' with the year '2026' in a separate parent element.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. Do not bind krw1-bdacs to attestation-pdf-index: that adapter selects the newest PDF link only when its href/text carries a parseable report date and an 'attestation/audit/report' keyword, and it fails closed with 'no dated PDF attestation/report links found' otherwise. The krw1 page's epoch-named PDF, bare 'Jul' anchor, and parent-scoped year satisfy neither, so a config would error at launch rather than publish static-validated coverage. Pre-wire instead when BDACS publishes dated CPA filenames (e.g. YYYYMMDD or 'Jul 2026' in the link) or after attestation-pdf-index gains a grouped year/month index parser.",
  },
  "nxusd-nereus": {
    sourceUrl: "https://github.com/nereusfinance/nereus-stablecoin-core/tree/e75e91b072a9d2346503383aafa2d40abc7ea582/deployments/avalanche",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "nereus-cauldron (promotion deferred; NXUSD-only LogDeploy census and complete collateral valuation required)",
    freshnessEvidence: "Reviewed 2026-09-09: Routescan LogDeploy discovery was latest-state, not an atomic census. Official Avalanche RPC block 94878322, timestamp 2026-09-09T19:17:34Z, independently confirms an omitted debt-bearing NXUSD clone and its collateral, BentoBox and oracle.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. Keep curated-validated. The pinned deployment manifest is neither NXUSD-only nor complete: five listed clones belong to the old MIM master, while current DegenBox 0x0b1f9c2211f77ec3fa2719671c5646cf6e59b775 LogDeploy events for NXUSD master 0xe767c6c3bf42f550a5a258a379713322b6c4c060 expose six unlisted clones, five with positive debt. Sample 0x51a8ff60fbaf277df02eeadc011f5c26dbae1991 has positive collateral shares and debt against vault token 0xfa71747531bc4bc8d86f847a3585b5e89043a8be; its TokenizedVaultOracle can supply a current rate but omits Chainlink timestamp validation. Missing: a complete NXUSD-only factory/master history including permissioned markets, same-block BentoBox.toAmount conversion for all positive collateral, reviewed LP/vault look-through and feed-age checks for every material asset, plus supply/debt reconciliation. Cached Cauldron exchangeRate has no freshness guarantee and must not substitute for those reads. No partial reserve mix or ratio is published.",
  },
  "hollar-hydrated": {
    sourceUrl: "https://rpc.hydradx.cloud",
    sourceQuality: "independent",
    expectedAdapterFamily: "hydration-hollar (new Substrate+EVM adapter; not bound — HSM balance census and cross-debt model incomplete)",
    freshnessEvidence: "Reviewed 2026-09-09: rpc.hydradx.cloud serves both frontier EVM methods and Substrate methods. HOLLAR is Aave-GHO-style: one GhoToken 0x531a654d1696ed52e7275a8cede955e82620f99a (supply 12,702,129.99) reconciles exactly to five facilitator buckets — Hydration Market 11,682,728.55 (pool 0x1b02e051683b5c, 23 reserves, per-block enshrined-oracle prices via AaveOracle 0xad33c0f0, HOLLAR variable debt 11,826,789.45 plus non-HOLLAR debt apyUSD/ETH/tBTC/PAXG), GIGAHDX 500,000 (pool 0x2ce2cfff743cdb, stHDX collateral $10.4M vs 503,682 debt), BIL 250,000 (pool 0x69310fda58c8, uBIL collateral $2.2M vs 250,616 debt), HOLLAR Stability Module 269,401.44, FlashMinter 0.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. The EVM side of the census is fully proven: all three live Aave v3 markets enumerate reserves with same-block totalAToken and per-block AaveOracle prices (base currency USD, 1e8), and the GhoToken facilitator buckets reconcile to supply exactly. Binding is blocked on the two non-EVM pieces. (1) The native HSM pallet (prefix twox128('HSM'), PalletId b'py/hsmod', module account 0x6d6f646c70792f68736d6f6400000000000000) is decoded: Collaterals maps assets 1002 (aUSDT) and 1003 (aUSDC) in HOLLAR stableswap pools 111/110 with buyback params, but the HSM account's actual balance storage was not resolved — Hydration's orml_tokens fork uses a non-standard Accounts key layout and an acct-first prefix probe returned empty, so the current aToken balance held by the HSM's EVM account still needs pinning down before the bucket can be valued (the pool getReserveData fork layout puts aTokenAddress at word 8). (2) aUSDC/aUSDT valuation needs a reviewed path (Aave liquidity-index-derived rate or the native ema-oracle entry for assets 1002/1003). (3) The Hydration Market shares collateral with non-HOLLAR borrows (apyUSD ~85.5k tokens at $1.367, ETH, tBTC, PAXG), so an attribution model must subtract them before publishing HOLLAR backing. Bind hydration-hollar only after those three settle; the EVM read path above is proven and reusable.",
  },
  "fxd-fathom": {
    sourceUrl: "https://docs.fathom.fi/fxd-stablecoin/deployments/xdc-network",
    sourceQuality: "independent",
    expectedAdapterFamily: "evm-branch-balances (not bound; psXDC collateral pool has no independent market price)",
    freshnessEvidence: "Reviewed 2026-09-09: XDC chainId 50 (verified 0x32 on erpc.xinfin.network). Three CollateralTokenAdapters measured: WXDC 0x2fc7e65023aFF27FA61A573B5C8E3fDe3CE9ef79 totalShare 7,471,325.30 WXDC (vault 0x9B4aCeFE…aA3a, DefiLlama $0.02854), CGO 0x30c64659AADD8C92328859A1CEE99721083A8E0f totalShare 0.068541 CGO (DefiLlama $141.45), psXDC 0xaf239a37a147f01717fd9a3583759dd4321dd71b totalShare 25,407,276.93 psXDC. The psXDC pool id 0x7073584443… is absent from the deployment docs and is enumerated only via the CollateralPoolConfig getAdapter/LogInitCollateralPoolId scan.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. FXD is a three-pool Maker-fork CDP (psXDC 74.5%, WXDC 25.5%, CGO ~0% by value, matching the reviewed 2026-07-30 sidecar), but evm-branch-balances cannot value the largest pool honestly. DefiLlama returns no price for psXDC 0x9b8e12b0bac165b86967e771d98b520ec3f665a6 (empty coins map), and the protocol only carries a 1:1-as-XDC priceWithSafetyMargin assumption with no market exchange-rate feed. A three-branch config would either omit psXDC (publishing a false ~27% collateralization from the WXDC+CGO sum) or require a hardcoded 1:1 XDC price (a silent-constant valuation fallback). Bind only once an independent psXDC market price exists (DefiLlama/CoinGecko listing or a reviewed staking-receipt rate feed); the XDC RPC is verified but not yet registered since no config uses it.",
  },
  "vusd-virtue": {
    sourceUrl: "https://docs.virtue.money/resources/technical-resources",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "virtue-iota-move (not built; Move CDP reader required — evm-branch-balances cannot read it)",
    freshnessEvidence: "Reviewed 2026-09-09: iota-evm chainId 8822 (verified 0x2276 on json-rpc.evm.iotaledger.net). All Virtue mainnet contracts are IOTA Move objects, not EVM: Framework 0x7400af41…b083b, VUSD Treasury 0xd3b63e60…904f, Oracle 0x7eebbee9…cc2cf, CDP 0x34fa327e…dd22, Stability Pool 0xc7ab9b93…d83b. The iota-evm VUSD 0x10740259a1860af3327dd0642ee35d6e8e7143ff is a bridged token whose totalSupply reads 9,978,371,123,948.46 at 6 decimals, irreconcilable with the canonical 584,037.06 VUSD supply.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. VUSD collateral (IOTA, stIOTA, vIOTA, iBTC) is locked in the IOTA Move CDP; the iota-evm leg is only a bridged token with a nonsensical inflated supply, so an EVM branch-balances config would read no collateral census. Reading the Move CDP requires a new Move/Antelope-style reader (the Worker has no IOTA Move transport today), an L effort out of scope for a branch-balances binding. Bind only after a Move CDP adapter exists.",
  },
  "lvusd-leverup": {
    sourceUrl: "https://docs.leverup.xyz/reference/contract-addresses",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "evm-branch-balances (not bound; VMMV vault address is not published)",
    freshnessEvidence: "Reviewed 2026-09-09: Monad chainId 143. lvUSD 0xfd44b35139ae53fff7d8f2a9869c503d987f00d1 totalSupply 1,401,850.34 (18dp); its owner 0x135951057cfccca7e8ef87ee41318d670f723f68 holds 0 USDC and 0 MON. LeverUp publishes only token addresses (LV, LVUSD, LVMON, LVP, LVHP) — no VMMV vault, minter, or collateral-holder contract.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. lvUSD backing is the VMMV (Virtual Market Making Vault) net collateral of the trading engine, not a single USDC holder: USDC (0x754704Bc059F8C67012fEd69BC8A327a5aafb603) plus AnyCollateral ecosystem tokens, moving with trader PnL and deploying excess USDC to yield strategies. A pinned-holder balanceOf config would publish a wrong partial basket (the actual USDC is spread across margin accounts/strategies with no published aggregation contract). Bind only if LeverUp publishes the vault/collateral contract or a reserve API that reconciles USDC vs lvUSD supply.",
  },
  "iusd-indigo-protocol": {
    sourceUrl: "https://docs.indigoprotocol.io/",
    sourceQuality: "weak-proof",
    expectedAdapterFamily: "indigo-cardano (not built; V3 vault datum layout is not publicly published)",
    freshnessEvidence: "Reviewed 2026-09-09: Koios pins the immutable PlutusV2 iUSD policy f66d78b4a3cb3d37afa0ec36461e51ecbde00f26c8f0a68f94b69880; no issuer timestamp or reserve API exists.",
    scoreGradePlausible: false,
    note: "Reviewed 2026-09-09. iUSD stays unbound: a raw CDP census requires decoding the inline datum of every live Indigo V3 vault UTxO, and the V3 (Aiken) validator/datum layout is not published. The only open-source contract repo (IndigoProtocol/indigo-smart-contracts) is the V1 Haskell core under BUSL-1.1; Indigo stated V2/V3 Aiken sources would be open-sourced after audit and they have not been. Reverse-engineering the datum layout from live UTxOs is not a reliable spec, and even a decoded vault census would be incomplete: Indigo's own indexer leaves 7.69% of iUSD supply unattributed (USDCx/USDM and governed peg-stability-module issuance), so a vault-only read cannot reconcile to policy supply. Bind only after Indigo publishes the V3 contract sources or a full supply-reconciled reserve API.",
  },
  "susd-hedgecore": {
    sourceUrl: null,
    sourceQuality: "unreviewed",
    expectedAdapterFamily: "two-layer HedgeCore census (sUSD wrapper lock book plus the undiscovered USDC sweep-target router/Venus vault) once the sweep target is identified",
    freshnessEvidence: "Reviewed 2026-09-09: BSC reads verified sUSD 0xbe192275…a23d (6,783,940 supply), hUSDC 0xc6182f64…35A5 (20,017,502), and the HUSDCWrapper 0x34EEa40F…94d3 one-way wrap with lock tracking (getHedgeLockInfo); all core contracts held ~0 USDC (0.05 dust), so the backing USDC sits in an undiscovered StrategyRouter/VenusUSDCVault.",
    scoreGradePlausible: false,
    note: "Deferred, not a weak supply-probe substitute. The wrap is one-way hUSDC→sUSD, so honest backing needs the full sweep-history census behind the router/vault; BscScan is API-keyless-deprecated, publicnode gates archive eth_getLogs, and bsc.drpc.org archive pages are rate-limited enough that discovery did not converge (recent 49.5k blocks showed zero USDC/vUSDC activity). Reopen only after the sweep-target contract is identified and its Venus census reads are pinned.",
  },
  "spusd-soulpeg": {
    sourceUrl: null,
    sourceQuality: "unreviewed",
    expectedAdapterFamily: "two-layer SoulPeg census (spUSD→sUSDC wrapper plus VenusUSDCVault/treasury look-through) once the sweep target is identified",
    freshnessEvidence: "Reviewed 2026-09-09: BSC reads verified spUSD 0x40ff3dea…77a6 (31,309,597 supply), sUSDC 0xC603ef9c…A24 (51,058,066), and the StUSDCWrapper 0x0e8fB2E7…238e 1:1 wrap; sUSDC is a StakeableAssetImpl proxy minted 1:1 from USDC and getProtocolStats confirms contractUSDCBalance ~0, with issuer docs naming VenusUSDCVault (ERC-4626) as the yield venue.",
    scoreGradePlausible: false,
    note: "Deferred for the same discovery blocker as susd-hedgecore: the two-layer look-through (spUSD→sUSDC→Venus USDC vault/treasury) cannot be measured honestly until the contract that received the swept USDC is identified on-chain. Reopen together with the HedgeCore census once that router/vault is pinned.",
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
