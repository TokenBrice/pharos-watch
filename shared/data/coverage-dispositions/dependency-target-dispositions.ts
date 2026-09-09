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
    targetId: "usr-resolv",
    expectedLifecycle: "frozen",
    action: "retain-reviewed-link",
    reviewer: "Codex dependency review",
    reviewedAt: "2026-07-23",
    sources: [
      { label: "Pharos frozen stablecoin snapshot", url: "https://pharos.watch/stablecoin/usr-resolv" },
      { label: "Inverse Finance DOLA transparency", url: "https://www.inverse.finance/transparency" },
    ],
    rationale:
      "DOLA's reviewed reserve composition includes USR. USR is frozen after its market failure, so retain the historical reserve dependency without treating the unavailable upstream as scoreable.",
  },
  {
    targetId: "cetes-etherfuse",
    expectedLifecycle: "quarantined",
    action: "retain-reviewed-link",
    reviewer: "Codex Prompt 6b dependency review",
    reviewedAt: "2026-07-20",
    sources: [
      { label: "Etherfuse CETES stablebond page", url: "https://app.etherfuse.com/bonds/cetes" },
      { label: "Brale MXNe", url: "https://brale.xyz/stablecoins/MXNe" },
    ],
    rationale:
      "MXNe's reviewed 100% reserve slice names tracked Etherfuse CETES. CETES is quarantined while runtime supply coverage is unavailable, so retain the reserve link with unavailable-upstream scoring.",
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
    targetId: "tbill-openeden",
    expectedLifecycle: "quarantined",
    action: "retain-reviewed-link",
    reviewer: "Codex Prompt 6b dependency review",
    reviewedAt: "2026-07-20",
    sources: [
      { label: "OpenEden TBILL", url: "https://openeden.com/tbill" },
      {
        label: "OpenEden USDO reserve assets",
        url: "https://docs.openeden.com/usdo/usdo-token/reserve-assets",
      },
    ],
    rationale:
      "OpenEden's reviewed USDO reserve composition names tracked TBILL. TBILL is quarantined while runtime supply coverage is unavailable, so retain the reserve link with unavailable-upstream scoring.",
  },
  {
    targetId: "wtgxx-wisdomtree",
    expectedLifecycle: "quarantined",
    action: "retain-reviewed-link",
    reviewer: "Codex Prompt 6b dependency review",
    reviewedAt: "2026-07-20",
    sources: [
      {
        label: "WisdomTree WTGXX",
        url: "https://www.wisdomtree.com/investments/etfs/digital-funds/wtgxx",
      },
      { label: "WisdomTree Connect", url: "https://www.wisdomtree.com/connect" },
    ],
    rationale:
      "WTGXX reserve slices are direct claims on the tracked WisdomTree fund. The fund is quarantined from active publication while runtime supply coverage is remediated, so those reviewed historical links remain correct without contributing an upstream score.",
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
  adapterReview("3jane-usd3", "worker/src/cron/reserve-adapters/3jane-usd3.ts", "Maps the liquid waUSDC/USDC reserve bucket to the canonical Circle USDC dependency while leaving the private-credit receivables unlinked.", "2026-07-13"),
  adapterReview("accountable", "worker/src/cron/reserve-adapters/accountable.ts", "Maps only configured, canonical asset rows from the Accountable reserve payload."),
  adapterReview("asymmetry", "worker/src/cron/reserve-adapters/asymmetry.ts", "Maps the reviewed afCVX and stablecoin branches to canonical upstream IDs."),
  adapterReview("blast-usdb-yield-manager", "worker/src/cron/reserve-adapters/blast-usdb-yield-manager.ts", "Maps balances from the reviewed Blast USDB yield-manager asset roster."),
  adapterReview("cap-vault", "worker/src/cron/reserve-adapters/cap-vault.ts", "Maps Cap vault asset addresses through the config-owned canonical asset roster."),
  adapterReview("collateral-positions-api", "worker/src/cron/reserve-adapters/collateral-positions-api.ts", "Infers canonical upstream IDs from exact collateral symbols using the protocol-specific resolver and fixed symbol mapping, while aggregated minor and unknown collateral remains unlinked.", "2026-09-01"),
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
  adapterReview("idle-cdo-epoch-variant", "worker/src/cron/reserve-adapters/idle-cdo-epoch-variant.ts", "Maps only the CDO's unlent underlying balance to its canonical deposit-token dependency; the borrower receivable is deliberately unlinked because a single-obligor credit claim is not a claim on that token.", "2026-09-01"),
  adapterReview("infinifi", "worker/src/cron/reserve-adapters/infinifi.ts", "Maps exact infiniFi reserve assets and leaves mixed unnamed baskets unresolved.", "2026-08-27"),
  adapterReview("jupusd", "worker/src/cron/reserve-adapters/jupusd.ts", "Maps Jupiter reserve assets through its reviewed canonical token roster."),
  adapterReview("liquity-v2-branches", "worker/src/cron/reserve-adapters/liquity-v2-branches.ts", "Maps each Liquity branch's reviewed stablecoin collateral identity."),
  adapterReview("m0-wrapper-underlying", "worker/src/cron/reserve-adapters/m0-wrapper-underlying.ts", "Emits the configured canonical M0 underlying for each wrapper."),
  adapterReview("mento", "worker/src/cron/reserve-adapters/mento.ts", "Maps Mento reserve assets using reviewed address and symbol identities shared by the active fiat cohort."),
  adapterReview("megausd-custody", "worker/src/cron/reserve-adapters/megausd-custody.ts", "Maps the reviewed MegaUSD custodian inventory rows (USDC and USDtb) to their canonical tracked-stablecoin IDs and excludes self-held USDm as self-referential.", "2026-09-09"),
  adapterReview("krwq-custodian", "worker/src/cron/reserve-adapters/krwq-custodian.ts", "Maps the issuer custodian-assets legs to canonical tracked IDs (USDC custodian and Base treasury USDC to usdc-circle, frxUSD custodian to frxusd-frax) and keeps each reported value even when the on-chain balanceOf verification fails or diverges.", "2026-09-09"),
  adapterReview("moc-v3-buckets", "worker/src/cron/reserve-adapters/usdrif-rif.ts", "Maps only the on-chain DOC bucket's market-valued collateral slice to the fixed canonical DOC dependency while leaving the RIF bucket unlinked.", "2026-09-01"),
  adapterReview("nest-vault-positions", "worker/src/cron/reserve-adapters/nest-vault-positions.ts", "Maps only exact reviewed Nest vault positions to canonical upstream IDs."),
  adapterReview("origin-vault-balances", "worker/src/cron/reserve-adapters/origin-vault-balances.ts", "Maps Origin vault balances through the reviewed asset-address roster."),
  adapterReview("parallelizer-balances", "worker/src/cron/reserve-adapters/parallelizer-balances.ts", "Maps dynamically enumerated Parallelizer balances through the reviewed token roster and leaves unconfigured residual collateral unlinked.", "2026-08-20"),
  adapterReview("pusd-vault", "worker/src/cron/reserve-adapters/pusd-vault.ts", "Maps Polymarket pUSD vault assets through the configured canonical roster."),
  adapterReview("re-metrics", "worker/src/cron/reserve-adapters/re-metrics.ts", "Maps Re Protocol reserve telemetry using reviewed canonical asset symbols."),
  adapterReview("reserve-protocol-dtf", "worker/src/cron/reserve-adapters/reserve-protocol-dtf.ts", "Maps DTF component addresses only when they resolve through the reviewed config roster."),
  adapterReview("resupply-pairs", "worker/src/cron/reserve-adapters/resupply-pairs.ts", "Maps Resupply pair collateral using the reviewed market-to-upstream identities."),
  adapterReview("saturn-pyusdx", "worker/src/cron/reserve-adapters/saturn-pyusdx.ts", "Emits the fixed canonical PayPal USD dependency at full weight for the reviewed PYUSDx MultiMint wrapper after verifying the pinned implementation and measuring its on-chain PYUSDx balance against supply.", "2026-09-09"),
  adapterReview("sgho-wrapper", "worker/src/cron/reserve-adapters/sgho-wrapper.ts", "Emits the configured canonical GHO parent for the sGHO wrapper."),
  adapterReview("solomon-protocol", "worker/src/cron/reserve-adapters/solomon-protocol.ts", "Maps Solomon vault and yield-distributor stablecoin balances through fixed reviewed identities and keeps unreconciled protocol TVL as an explicit unmapped very-high slice.", "2026-08-20"),
  adapterReview("usdai-hub", "worker/src/cron/reserve-adapters/usdai-hub.ts", "Emits the fixed canonical PYUSD dependency at full weight after verifying the configured hub base token and measuring its on-chain balance.", "2026-09-01"),
  adapterReview("usdd-data-platform", "worker/src/cron/reserve-adapters/usdd-data-platform.ts", "Maps exact USDD reserve assets from the reviewed data-platform response."),
  adapterReview("usdtb-transparency", "worker/src/cron/reserve-adapters/usdtb-transparency.ts", "Maps USDtb transparency rows through its reviewed canonical asset-key roster."),
  adapterReview("xdai-bridge", "worker/src/cron/reserve-adapters/xdai-bridge.ts", "Maps the complete measured bridge collateral to fixed canonical sUSDS and USDS dependencies according to their on-chain balances while leaving legacy DAI and sDAI unmapped.", "2026-09-01"),
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
];
