export type DependencyTargetLifecycle = "active" | "pre-launch" | "quarantined" | "delisted" | "frozen";

export interface DependencyTargetDisposition {
  targetId: string;
  expectedLifecycle: DependencyTargetLifecycle;
  action: "retain-reviewed-link";
  reviewer: string;
  reviewedAt: string;
  sources: Array<{ label: string; url: string }>;
  rationale: string;
}

export interface DependencyAdapterMappingReview {
  adapter: string;
  reviewer: string;
  reviewedAt: string;
  sourceFiles: string[];
  rationale: string;
}

function adapterReview(
  adapter: string,
  sourceFile: string,
  rationale: string,
  reviewedAt = "2026-07-12",
): DependencyAdapterMappingReview {
  return {
    adapter,
    reviewer: "Codex dependency mapping review",
    reviewedAt,
    sourceFiles: [sourceFile],
    rationale,
  };
}

/**
 * Reviewed upstreams that are canonical tracked assets but currently cannot
 * contribute their own report-card score. Keep this registry limited to
 * targets observed as unavailable by the dependency coverage audit.
 */
export const DEPENDENCY_TARGET_DISPOSITIONS: readonly DependencyTargetDisposition[] = [
  {
    targetId: "benji-franklin-templeton",
    expectedLifecycle: "quarantined",
    action: "retain-reviewed-link",
    reviewer: "Codex reserve recovery review",
    reviewedAt: "2026-09-14",
    sources: [{ label: "Ondo OUSG dated portfolio", url: "https://ondo.finance/ousg" }],
    rationale:
      "OUSG's September 11 portfolio explicitly holds Franklin OnChain U.S. Government Money Fund (BENJI). Retain that measured collateral dependency while the tracked fund is quarantined; the link does not make BENJI scoreable or remove unavailable-upstream treatment.",
  },
  {
    targetId: "rusd-reservoir",
    expectedLifecycle: "active",
    action: "retain-reviewed-link",
    reviewer: "Codex Prompt 6b dependency review",
    reviewedAt: "2026-07-20",
    sources: [
      { label: "Reservoir documentation", url: "https://docs.reservoir.xyz" },
      { label: "Reservoir proof of reserves", url: "https://app.reservoir.xyz/reserves" },
    ],
    rationale:
      "srUSD and wrapped srUSD are direct claims on Reservoir rUSD. rUSD is tracked and active, but its current report card is NR, so the reviewed wrapper link must remain visible with unavailable-upstream scoring.",
  },
  {
    targetId: "zsd-zephyr-protocol",
    expectedLifecycle: "active",
    action: "retain-reviewed-link",
    reviewer: "Codex dependency review",
    reviewedAt: "2026-07-12",
    sources: [
      { label: "Zephyr documentation", url: "https://zephyrprotocol.com/documentation" },
      { label: "Zephyr yield dashboard", url: "https://zephyrprotocol.com/yield" },
    ],
    rationale:
      "ZYS is a yield-share claim on the ZSD yield reserve. ZSD is tracked and active, but its current report card is NR, so the reviewed wrapper link remains correct with unavailable-upstream scoring.",
  },
];

/** Exact adapters observed producing mapped live dependency sets in the P1b replay. */
export const DEPENDENCY_ADAPTER_MAPPING_REVIEWS: readonly DependencyAdapterMappingReview[] = [
  adapterReview("ondo-ousg", "worker/src/cron/reserve-adapters/ondo-ousg.ts", "Maps only the exact reviewed Sanity IDs and matching names/symbols for BUIDL, BENJI and USDC. Other fund, bank and residual rows stay unlinked; quarantined BENJI remains unavailable for upstream scoring.", "2026-09-14"),
  adapterReview("midas-mtbill", "worker/src/cron/reserve-adapters/midas-mtbill.ts", "Maps only the exact reviewed unleveraged USTB/BUIDL position tuples. The entire residual stays unclassified and unlinked, with source totals and scope required to reconcile.", "2026-09-14"),
  adapterReview("hylo-solana", "worker/src/cron/reserve-adapters/hylo-solana.ts", "Maps only the pinned SPL USDC vault/mint to usdc-circle; the registry-enumerated LST pool and pinned cbBTC/HYPE pools remain untracked cryptoasset exposures. Unknown LSTs or activation of an unreviewed exogenous pair fail closed.", "2026-09-09"),
  adapterReview("3jane-usd3", "worker/src/cron/reserve-adapters/3jane-usd3.ts", "Maps the liquid waUSDC/USDC reserve bucket to the canonical Circle USDC dependency while leaving the private-credit receivables unlinked.", "2026-07-13"),
  adapterReview("accountable", "worker/src/cron/reserve-adapters/accountable.ts", "Maps only configured, canonical asset rows from the Accountable reserve payload."),
  adapterReview("blast-usdb-yield-manager", "worker/src/cron/reserve-adapters/blast-usdb-yield-manager.ts", "Maps balances from the reviewed Blast USDB yield-manager asset roster."),
  adapterReview("cap-vault", "worker/src/cron/reserve-adapters/cap-vault.ts", "Maps Cap vault asset addresses through the config-owned canonical asset roster."),
  adapterReview("collateral-positions-api", "worker/src/cron/reserve-adapters/collateral-positions-api.ts", "Infers canonical upstream IDs from exact collateral symbols using the protocol-specific resolver and fixed symbol mapping, while aggregated minor and unknown collateral remains unlinked.", "2026-09-01"),
  adapterReview("curated-validated", "worker/src/cron/reserve-adapters/curated-validated.ts", "Republishes the coin's reviewed static reserves array unchanged once probeTrackedTokenSupply reads a positive on-chain totalSupply, so the only upstream IDs it can emit are the authored slice coinId values: alUSD's DAI/USDC/USDT/FRAX yield-token collateral to dai-makerdao, usdc-circle, usdt-tether and frax-frax; spUSD's and HedgeCore sUSD's Venus-routed USDC to usdc-circle; Solayer sUSD's OpenEden reserve to cusdo-openeden. It resolves no label, address or symbol itself, so any authored slice without a coinId stays unlinked. An empty reserves array or a missing, unreadable or zero totalSupply fails the adapter closed.", "2026-09-22"),
  adapterReview("dola-inverse", "worker/src/cron/reserve-adapters/dola-inverse.ts", "Uses the reviewed tracked-stablecoin symbol resolver for exact DOLA reserve assets, including sDOLA-paired Curve/Yearn wrappers mapped to the non-DOLA leg (reUSD → reusd-resupply).", "2026-08-27"),
  adapterReview("erc4626-single-asset", "worker/src/cron/reserve-adapters/erc4626-single-asset.ts", "Maps only measured idle underlying holdings to the configured canonical asset; deployed strategy and unreadable holdings remain unlinked and feed unknownExposurePct. fxSAVE holds untracked fxSP shares, not fxUSD directly.", "2026-09-09"),
  adapterReview("escrow-balance", "worker/src/cron/reserve-adapters/escrow-balance.ts", "Emits the single configured canonical escrowed asset for the pinned escrow contract.", "2026-08-12"),
  adapterReview("ethena-whitelabel", "worker/src/cron/reserve-adapters/ethena-whitelabel.ts", "Maps on-chain USDe/USDC custodian rows to canonical upstream IDs and leaves the Coinbase Prime off-chain custody balance unlinked.", "2026-09-09"),
  adapterReview("evm-branch-balances", "worker/src/cron/reserve-adapters/evm-branch-balances.ts", "Maps branch balances only from config entries carrying canonical coin IDs."),
  adapterReview("falcon", "worker/src/cron/reserve-adapters/falcon.ts", "Maps exact transparency asset labels through fixed reviewed tracked-stablecoin and tracked-RWA tables while leaving residual bucket exposure unlinked.", "2026-09-01"),
  adapterReview("flying-tulip-ftusd", "worker/src/cron/reserve-adapters/flying-tulip-ftusd.ts", "Maps only the reviewed Ethereum and Sonic USDC, USDT, and USSD collateral addresses to canonical upstream IDs.", "2026-08-09"),
  adapterReview("frax-balance-sheet", "worker/src/cron/reserve-adapters/frax.ts", "Uses the subject-aware reviewed Frax reserve mapping and suppresses self-links."),
  adapterReview("frax-fpi-collateral", "worker/src/cron/reserve-adapters/frax.ts", "Maps the reviewed FPI collateral roster to canonical upstream IDs."),
  adapterReview("gho", "worker/src/cron/reserve-adapters/gho.ts", "Maps only reviewed GHO facilitator reserve assets while leaving issuance-only labels unlinked."),
  adapterReview("sodax-sonic", "worker/src/cron/reserve-adapters/sodax-sonic.ts", "Maps exact reviewed Sonic reserve wrapper addresses to USDC, USDT, and ftUSD; API borrower candidates must reconcile exactly to pinned non-transferable scaled debt supply. Unknown reserves are quantified, and v1/v2 inventory uncertainty keeps the adapter weak-live-probe.", "2026-09-09"),
  adapterReview("idle-cdo-epoch-variant", "worker/src/cron/reserve-adapters/idle-cdo-epoch-variant.ts", "Maps only the CDO's unlent underlying balance to its canonical deposit-token dependency; the borrower receivable is deliberately unlinked because a single-obligor credit claim is not a claim on that token.", "2026-09-01"),
  adapterReview("infinifi", "worker/src/cron/reserve-adapters/infinifi.ts", "Maps exact infiniFi reserve assets and leaves mixed unnamed baskets unresolved.", "2026-08-27"),
  adapterReview("jupusd", "worker/src/cron/reserve-adapters/jupusd.ts", "Maps Jupiter reserve assets through its reviewed canonical token roster."),
  adapterReview("kava-cdp", "worker/src/cron/reserve-adapters/kava-cdp.ts", "Keys each priced CDP collateral denom as kava-cdp:<denom> through the /kava/cdp/v1beta1/params type-to-denom map, so the reviewed kava-cdp:erc20/tether/usdt row is the only tracked link (usdt-tether); hbtc, btcb, xrpb, ukava, bnb and busd remain unlinked exogenous collateral. A collateral type whose spot_market_id has no live pricefeed entry is excluded from the slice set and quantified instead as its share of USDX principal. A missing usdx:usd price, a principal or bank-supply row not denominated in usdx, a duplicate collateral_params row, zero total priced collateral, or a failed block-identity check fails the adapter closed.", "2026-09-22"),
  adapterReview("liquity-v2-branches", "worker/src/cron/reserve-adapters/liquity-v2-branches.ts", "Maps each Liquity branch's reviewed stablecoin collateral identity."),
  adapterReview("m0", "worker/src/cron/reserve-adapters/m0.ts", "Publishes exactly one aggregate slice keyed m0:eligible-collateral from minterGateway_totalCollateralSnapshots[0].value at six decimals and emits no coinId at all: the shared M0 collateral pool is a T-bill and cash claim of the Minter Gateway, so the m-m0 wrapper link for USDK, USDN and XO stays owned by each coin's reviewed static wrapper row rather than inferred from this common feed. minterGateway_minters rows are reconciliation-only and never become slices. A missing snapshot, a non-numeric or negative snapshot value, a GraphQL errors payload, or an unset M0_API_KEY fails the adapter closed; a minter-sum divergence above 0.5% or snapshot lag beyond 12h degrades instead.", "2026-09-22"),
  adapterReview("m0-wrapper-underlying", "worker/src/cron/reserve-adapters/m0-wrapper-underlying.ts", "Emits the configured canonical M0 underlying for each wrapper."),
  adapterReview("mento", "worker/src/cron/reserve-adapters/mento.ts", "Maps Mento reserve assets using reviewed address and symbol identities shared by the active fiat cohort."),
  adapterReview("megausd-custody", "worker/src/cron/reserve-adapters/megausd-custody.ts", "Maps the reviewed MegaUSD custodian inventory rows (USDC and USDtb) to their canonical tracked-stablecoin IDs and excludes self-held USDm as self-referential.", "2026-09-09"),
  adapterReview("krwq-custodian", "worker/src/cron/reserve-adapters/krwq-custodian.ts", "Maps the issuer custodian-assets legs to canonical tracked IDs (USDC custodian and Base treasury USDC to usdc-circle, frxUSD custodian to frxusd-frax) and keeps each reported value even when the on-chain balanceOf verification fails or diverges.", "2026-09-09"),
  adapterReview("moc-v3-buckets", "worker/src/cron/reserve-adapters/usdrif-rif.ts", "Maps only the on-chain DOC bucket's market-valued collateral slice to the fixed canonical DOC dependency while leaving the RIF bucket unlinked.", "2026-09-01"),
  adapterReview("nest-vault-positions", "worker/src/cron/reserve-adapters/nest-vault-positions.ts", "Maps only exact reviewed Nest vault positions to canonical upstream IDs."),
  adapterReview("origin-vault-balances", "worker/src/cron/reserve-adapters/origin-vault-balances.ts", "Maps Origin vault balances through the reviewed asset-address roster."),
  adapterReview("parallelizer-balances", "worker/src/cron/reserve-adapters/parallelizer-balances.ts", "Maps dynamically enumerated Parallelizer balances through the reviewed token roster and leaves unconfigured residual collateral unlinked.", "2026-08-20"),
  adapterReview("re-metrics", "worker/src/cron/reserve-adapters/re-metrics.ts", "Maps Re Protocol reserve telemetry using reviewed canonical asset symbols."),
  adapterReview("reserve-protocol-dtf", "worker/src/cron/reserve-adapters/reserve-protocol-dtf.ts", "Maps DTF component addresses only when they resolve through the reviewed config roster."),
  adapterReview("resupply-pairs", "worker/src/cron/reserve-adapters/resupply-pairs.ts", "Maps Resupply pair collateral using the reviewed market-to-upstream identities."),
  adapterReview("saturn-pyusdx", "worker/src/cron/reserve-adapters/saturn-pyusdx.ts", "Emits the fixed canonical PayPal USD dependency at full weight for the reviewed PYUSDx MultiMint wrapper after verifying the pinned implementation and measuring its on-chain PYUSDx balance against supply.", "2026-09-09"),
  adapterReview("solomon-protocol", "worker/src/cron/reserve-adapters/solomon-protocol.ts", "Maps Solomon vault and yield-distributor stablecoin balances through fixed reviewed identities and keeps unreconciled protocol TVL as an explicit unmapped very-high slice.", "2026-08-20"),
  adapterReview("usdai-hub", "worker/src/cron/reserve-adapters/usdai-hub.ts", "Emits the fixed canonical PYUSD dependency at full weight after verifying the configured hub base token and measuring its on-chain balance.", "2026-09-01"),
  adapterReview("usdd-data-platform", "worker/src/cron/reserve-adapters/usdd-data-platform.ts", "Maps exact USDD reserve assets from the reviewed data-platform response."),
  adapterReview("usdtb-transparency", "worker/src/cron/reserve-adapters/usdtb-transparency.ts", "Maps USDtb transparency rows through its reviewed canonical asset-key roster."),
  adapterReview("xdai-bridge", "worker/src/cron/reserve-adapters/xdai-bridge.ts", "Maps the complete measured bridge collateral to fixed canonical sUSDS and USDS dependencies according to their on-chain balances while leaving legacy DAI and sDAI unmapped.", "2026-09-01"),
  adapterReview("xpr-account-balances", "worker/src/cron/reserve-adapters/xpr-account-balances.ts", "Measures only the configured xtokens symbols held by xmd.treasury (XUSDC and XPYUSD) against the xmd.token XMD currency-stats supply and deliberately emits no coinId: XPR X-tokens are issuer-custodial Metal X bridge wrappers whose 1:1 upstream backing is not independently published, which the adapter records as a bridge-wrapper-unverified info warning. Supply beyond the measured balances becomes the explicit unknown remainder for non-xtokens treasury holdings such as MPD. A configured slice symbol missing from get_currency_balance, a supply-symbol mismatch, a non-array balance response, a non-positive supply, or an unreadable head-block identity fails the adapter closed.", "2026-09-22"),
  adapterReview("youves-tezos", "worker/src/cron/reserve-adapters/youves-tezos.ts", "Censuses the eight pinned uUSD engine contracts and folds their vault collateral into four fixed keys (youves-tezos:usdt, :xtz, :tzbtc, :sirs), so the reviewed youves-tezos:usdt row for the pinned Tezos USDt token KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o is the only tracked link (usdt-tether); XTZ, tzBTC and the XTZ/tzBTC SIRS LP tokens remain unlinked exogenous collateral. A uUSD token_contract other than KT1XRPEPXbZK25r3Htzp2o1x7xdMMmfocKNW, SIRS LP oracle token addresses that do not match the pinned tzBTC and SIRS identities, a missing material collateral price, or a uUSD supply below the engines' summed total_supply fails the census closed.", "2026-09-22"),
  {
    adapter: "astherus-earn-wrapper",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/astherus-earn-wrapper.ts"],
    rationale: "Maps the identity-verified USDF backing of the custom earn wrapper to the configured canonical parent, excluding unvested backing.",
  },
  {
    adapter: "initia-wrapper-vault",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/initia-wrapper-vault.ts"],
    rationale: "Maps only the pinned AUSD0 vault backing to ausd-agora after verifying Move vault and metadata identities.",
  },
  {
    adapter: "usdgo-transparency",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/usdgo-transparency.ts"],
    rationale: "Maps the explicitly disclosed BUIDL fund share reserve to buidl-blackrock; cash and other issuer reserve categories remain unlinked.",
  },
  {
    adapter: "makina-strategy",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/makina-strategy.ts"],
    rationale: "Maps unallocated USDC base-token balances to usdc-circle; protocol strategy buckets and unknown positions are not treated as token dependencies.",
  },
  {
    adapter: "reservoir",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/reservoir.ts"],
    rationale: "Maps the reviewed exact USDAT asset category to usdat-saturn; other collateral and strategy buckets remain unlinked.",
  },
  {
    adapter: "usdai-proof-of-reserves",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/usdai-proof-of-reserves.ts"],
    rationale: "Maps exact liquid reserve token codes PYUSD, USDC, USDT and M0 aliases to canonical tracked assets, leaving hardware-loan DEAL exposure unlinked.",
  },
  {
    adapter: "attestation-pdf-index",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/attestation-pdf-index.ts"],
    rationale: "Preserves only explicit canonical coin IDs from reviewed per-coin attestation slice configuration; report discovery does not infer dependencies.",
  },
  {
    adapter: "liquity-v1",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/liquity-v1.ts"],
    rationale: "Preserves only the configured canonical collateral ID from the reviewed single-collateral slice; current LUSD ETH collateral remains unlinked.",
  },
  {
    adapter: "spiko-api",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/spiko-api.ts"],
    rationale: "Preserves only an explicitly reviewed configured parent ID for the measured share-class bucket, never resolving a display label to an upstream.",
  },
  {
    adapter: "united-por",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/united-por.ts"],
    rationale: "Preserves only an explicit configured dependency for the aggregate reviewed bucket; the current mixed United reserve bucket carries no inferred token link.",
  },
  {
    adapter: "yamato",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/yamato.ts"],
    rationale: "Preserves only an explicitly reviewed configured collateral ID; current CJPY ETH collateral remains unlinked.",
  },
  {
    adapter: "zephyr-scanner",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/zephyr-scanner.ts"],
    rationale: "Maps the ZYS yield-reserve wrapper to the fixed canonical ZSD parent; endogenous ZEPH reserve exposure remains unlinked.",
  },
  {
    adapter: "single-asset",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/single-asset.ts"],
    rationale: "Preserves only explicitly reviewed configured canonical IDs on static reserve slices, including the Plume USDC receivable; it does not infer dependencies from labels.",
  },
  {
    adapter: "onre-holdings-csv",
    reviewer: "pharos-live-reserve-upgrade",
    reviewedAt: "2026-09-09",
    sourceFiles: ["worker/src/cron/reserve-adapters/onre-holdings-csv.ts"],
    rationale: "Maps the reviewed Schedule of Assets rows through a fixed table mirroring the sidecar: USDG/sUSDS/syrupUSDC/sUSDe/USYC/USDC to canonical tracked IDs with Kamino lending rows as protocol positions of their upstream assets; T-bills, USCC and cash stay unlinked.",
  },
];
