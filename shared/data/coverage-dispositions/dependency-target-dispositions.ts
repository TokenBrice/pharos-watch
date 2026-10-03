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
  reviewer = "Codex dependency mapping review",
): DependencyAdapterMappingReview {
  return {
    adapter,
    reviewer,
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
];

/** Exact adapters observed producing mapped live dependency sets in the P1b replay. */
export const DEPENDENCY_ADAPTER_MAPPING_REVIEWS: readonly DependencyAdapterMappingReview[] = [
  adapterReview("sky-makercore", "worker/src/cron/reserve-adapters/sky-makercore.ts", "Verifies LitePSM gem() and pocket() against canonical Ethereum USDC and measures the pocket balance in the same adapter run. Maps only the reconciled USDC constituent to usdc-circle with collateral depType; residual and reconciliation-failed PSM groups remain unlinked. The 0.25 percentage-point timing/rounding band is recorded as excess metadata, and the shared DAI/USDS book carries one measured holding.", "2026-09-30"),
  {
    adapter: "leverup-lvusd",
    reviewer: "Sol final review 2026-10-02 (AdapterMappingReviews)",
    reviewedAt: "2026-10-02",
    sourceFiles: [
      "worker/src/cron/reserve-adapters/leverup-lvusd.ts",
      "worker/src/cron/reserve-adapters/evm-branch-balances.ts",
      "worker/src/cron/reserve-adapters/branch-balances.ts",
    ],
    rationale: "Maps only the measured Monad USDC balance at designated vault 0xc69d584b3118e94b3443cc6c67076281242fa704 to usdc-circle with collateral depType and sourceKey evm-branch-balances:monad:0x754704bc059f8c67012fed69bc8a327a5aafb603. At one pinned block, verifies the tracked LVUSD contract, owner-to-issuer-to-transparency chain, exact getAllVaults() holder census, vault reserveToken() and reserve/liability decimals before shared branch accounting market-values the balance. Registry or identity drift and unreadable liabilities fail closed; unavailable reserve balances, decimals or prices produce only an unlinked residual. LVMON, MON staking, incidental vault tokens and the reserve-versus-supply shortfall create no reserve links. A complete one-asset composition is 100% USDC regardless of coverage; the actual undercollateralization warning is retained and no redemption capacity is inferred.",
  },
  {
    adapter: "solomon-chancery",
    reviewer: "Sol final review 2026-10-02 (AdapterMappingReviews)",
    reviewedAt: "2026-10-02",
    sourceFiles: ["worker/src/cron/reserve-adapters/solomon-chancery.ts"],
    rationale: "Maps positive balances only from the four exact Solana mint/symbol/reserve-account tuples for replacement USDv mint USDvUSpnhCr9yBgj3UyVrD239HRUv4RsHwH2FxsWuMk and Chancery reserve authority 8anxfyoftY9hPwxdvReet2beFS2HXjcXraPEamo4nGyB: USDC to usdc-circle, USDG to usdg-paxos, PYUSD to pyusd-paypal and USDT to usdt-tether, all with collateral depType and chancery:reserve:<lowercase-symbol> source keys. Zero balances, including PYUSD and USDT in the captured response, emit no slices or links. Inventory, duplicate, mint, vault, symbol, timestamp, positive-balance decimals, raw-unit or nominal-par valuation mismatches and an unreconciled total fail closed; no unknown constituent is resolved by symbol alone. Weights use the reconciled selected-account total at nominal USD 1, never USDv supply. Off-account assets, liabilities, encumbrances and legacy USDv remain outside the mapping; the selected-reserve-scope warning and financialAssurance=false are retained without whole-book coverage or redemption claims.",
  },
  adapterReview("theo-thusd-redemption", "worker/src/cron/reserve-adapters/theo-thusd-redemption.ts", "Republishes thusd-theo's full reviewed curated reserves array unchanged: thBILL maps to thbill-theo, USDC redemption liquidity to usdc-circle and USDT redemption liquidity to usdt-tether, all with collateral depType and no authored sourceKey. The aggregate delta-neutral gold carry row remains unlinked exogenous strategy exposure under its reviewed non-link disposition. The adapter resolves no label, address or symbol into reserve links and introduces no source keys; its pinned same-block Cash Wallet balance/allowance probe emits nested redemption telemetry only, never replacement reserve weights or new dependency claims. Missing or invalid full curated composition fails closed.", "2026-09-30"),
  adapterReview("ondo-ousg", "worker/src/cron/reserve-adapters/ondo-ousg.ts", "Maps only the exact reviewed Sanity IDs and matching names/symbols for BUIDL, BENJI and USDC. Other fund, bank and residual rows stay unlinked; quarantined BENJI remains unavailable for upstream scoring.", "2026-09-14"),
  adapterReview("midas-mtbill", "worker/src/cron/reserve-adapters/midas-mtbill.ts", "Maps only the exact reviewed unleveraged USTB/BUIDL position tuples. The entire residual stays unclassified and unlinked, with source totals and scope required to reconcile.", "2026-09-14"),
  adapterReview("hylo-solana", "worker/src/cron/reserve-adapters/hylo-solana.ts", "Maps only the pinned SPL USDC vault/mint to usdc-circle; the registry-enumerated LST pool and pinned cbBTC/HYPE pools remain untracked cryptoasset exposures. Unknown LSTs or activation of an unreviewed exogenous pair fail closed.", "2026-09-09"),
  adapterReview("3jane-usd3", "worker/src/cron/reserve-adapters/3jane-usd3.ts", "Maps the liquid waUSDC/USDC reserve bucket to the canonical Circle USDC dependency while leaving the private-credit receivables unlinked.", "2026-07-13"),
  adapterReview("accountable", "worker/src/cron/reserve-adapters/accountable.ts", "Maps only configured, canonical asset rows from the Accountable reserve payload."),
  adapterReview("blast-usdb-yield-manager", "worker/src/cron/reserve-adapters/blast-usdb-yield-manager.ts", "Maps balances from the reviewed Blast USDB yield-manager asset roster."),
  adapterReview("cap-vault", "worker/src/cron/reserve-adapters/cap-vault.ts", "Maps Cap vault asset addresses through the config-owned canonical asset roster."),
  adapterReview("collateral-positions-api", "worker/src/cron/reserve-adapters/collateral-positions-api.ts", "Infers canonical upstream IDs from exact collateral symbols using the protocol-specific resolver and fixed symbol mapping, while aggregated minor and unknown collateral remains unlinked.", "2026-09-01"),
  adapterReview("curated-validated", "worker/src/cron/reserve-adapters/curated-validated.ts", "Republishes the coin's reviewed static reserves array unchanged once probeTrackedTokenSupply reads a positive on-chain totalSupply, so the only upstream IDs it can emit are the authored slice coinId values: alUSD's DAI/USDC/USDT/FRAX yield-token collateral to dai-makerdao, usdc-circle, usdt-tether and frax-frax; spUSD's and HedgeCore sUSD's Venus-routed USDC to usdc-circle; Solayer sUSD's OpenEden reserve to cusdo-openeden. It resolves no label, address or symbol itself, so any authored slice without a coinId stays unlinked. An empty reserves array or a missing, unreadable or zero totalSupply fails the adapter closed.", "2026-09-22"),
  adapterReview("dola-inverse", "worker/src/cron/reserve-adapters/dola-inverse.ts", "Links only directly identified tracked-stablecoin collateral via exact symbols. Curve and Yearn LP-secured debt remains undecomposed and unlinked: an sDOLA-paired LP is not a measured holding of its external leg. Same-run official repayments separate verified Frontier bad debt from non-FiRM issuance; the uniquely keyed insufficient-evidence residual stays unlinked and bounded-unknown, including failed or unreconciled repayment reads.", "2026-10-02"),
  adapterReview(
    "erc4626-single-asset",
    "worker/src/cron/reserve-adapters/erc4626-single-asset.ts",
    "Requires asset() to match the configured expectedAssetAddress before carrying the explicit canonical coinId and depType; sourceKey is erc4626-single-asset:<chain>:<asset-address>. Normally maps only measured idle underlying holdings; unreviewed deployed strategy and unreadable holdings stay unlinked and feed unknownExposurePct. fxSAVE holds untracked fxSP shares, not fxUSD directly. A dated deployedExposure review permits a full parent-denominated Morpho lender-claim slice only when idle holdings are readable: 100% describes the reviewed lending claim, not idle cash, borrower collateral, redemption capacity or risk-free backing. Borrower collateral and credit/liquidity risk remain local. pooledClaim suppresses links entirely, including syrupusdg-maple despite its USDG accounting asset. " +
      "The following 31 new wrapper identities were re-observed through pinned-block eth_call(asset()) on 2026-10-03; every returned address matched its configured expectedAssetAddress. Ethereum block 0x18e60be via https://ethereum-rpc.publicnode.com; Base blocks 0x31af49c/0x31af49d via https://base-rpc.publicnode.com; Gnosis 0x2e4f0ec via https://rpc.gnosischain.com; Tempo 0x285f014 via https://rpc.tempo.xyz; Monad 0x68ef484 via https://rpc.monad.xyz; Arc 0x16d9fdc/0x16d9fde via https://rpc.mainnet.arc.io; Robinhood 0x4b0063f via https://rpc.mainnet.chain.robinhood.com. Primary claim sources and the reviewed 2026-10-02 deployedExposure scopes are identified below. " +
      "sreusd-resupply: Ethereum 0x557ab1e003951a73c12d16f0fea8490e39c33c35 holds reUSD 0x57ab1e0003f623289cd798b1824be09a793e4bec -> reusd-resupply (wrapper, measured idle only); https://docs.resupply.finance/resupply-protocol/savings-reusd.md. " +
      "susdf-falcon: Ethereum 0xc8cf6d7991f15525488b2a83df53468d682ba4b0 holds USDf 0xfa2b947eec368f42195f24f36d2af29f7c24cec2 -> usdf-falcon (wrapper, measured idle only); https://docs.falcon.finance/earn/susdf-yield-bearing-token.md. " +
      "strusd-tori: Ethereum 0x280839980a7ed0d7717f64125fe241012e5f5815 holds trUSD 0xd0580192e98ea6ceb9c7b6191ed2e27560911697 -> trusd-tori (wrapper, measured idle only); https://docs.tori.finance/products/strusd.md. " +
      "sfrax-frax: Ethereum 0xa663b02cf0a4b149d2ad41910cb81e23e1c41c32 holds FRAX 0x853d955acef822db058eb8505911ed77f175b99e -> frax-frax (wrapper, measured idle only); https://docs.frax.finance/frax-v3-100-cr-and-more/sfrax. " +
      "sdai-gnosis: Gnosis 0xaf204776c7245bf4147c2612bf6e5972ee483701 holds WXDAI 0xe91d153e0b41518a2ce8dd3d7944fa863463a97d -> xdai-gnosis (wrapper, measured idle only; no inferred Ethereum DAI claim); verified SavingsXDai source https://gnosis.blockscout.com/api/v2/smart-contracts/0xaf204776c7245bf4147c2612bf6e5972ee483701. " +
      "senpyusdmain-sentora: Ethereum 0xb576765fb15505433af24fee2c0325895c559fb2 holds PYUSD 0x6c3ea9036406852006290770bedfcaba0e23a0e8 -> pyusd-paypal (wrapper, measured idle only; no deployedExposure review); https://app.morpho.org/ethereum/vault/0xb576765fb15505433af24fee2c0325895c559fb2. " +
      "senpyusdprimev2-sentora: Ethereum 0xc21b08c16458202593d4d9b26b9984ee67b38bbd holds the same Ethereum PYUSD -> pyusd-paypal (wrapper, measured idle only; no deployedExposure review); https://app.morpho.org/ethereum/vault/0xc21b08c16458202593d4d9b26b9984ee67b38bbd. " +
      "senrlusdv2-sentora: Ethereum 0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf holds RLUSD 0x8292bb45bf1ee4d140127049757c2e0ff06317ed -> rlusd-ripple (wrapper, measured idle only; no deployedExposure review); https://app.morpho.org/ethereum/vault/0x6dc58a0fdfc8d694e571dc59b9a52eeea780e6bf. " +
      "senpathusd-sentora: Tempo 0x9a044ae05e5e6290dcf56afd69548565e957a626 holds pathUSD 0x20c0000000000000000000000000000000000000 -> pathusd-bridge (wrapper); reviewed complete idle plus single cbBTC-secured lender position reconciles at block 42323768; https://app.morpho.org/tempo/vault/0x9a044ae05e5e6290dcf56afd69548565e957a626. " +
      "senpyusdpst-sentora: Ethereum 0x8381a156958711e230f325428b5eb4b6555c75d9 holds Ethereum PYUSD -> pyusd-paypal (wrapper); reviewed idle plus single Huma PST-secured lender position reconciles at block 26107706; https://app.morpho.org/ethereum/vault/0x8381a156958711e230f325428b5eb4b6555c75d9. " +
      "senpyusdmwin-sentora: Ethereum 0x7cbcfc4f64be199ede6db1d916ddcdb69f666b57 holds Ethereum PYUSD -> pyusd-paypal (wrapper); reviewed idle plus single mWIN-secured lender position reconciles at block 26107706; https://app.morpho.org/ethereum/vault/0x7cbcfc4f64be199ede6db1d916ddcdb69f666b57. " +
      "sxsrlusd-sentora: Ethereum 0xfc8c624b6080a0a780583799f2a862de936f6e22 holds Ethereum RLUSD -> rlusd-ripple (wrapper); reviewed idle plus single WBTC-secured lender position reconciles at block 26107706; https://app.morpho.org/ethereum/vault/0xfc8c624b6080a0a780583799f2a862de936f6e22. " +
      "krusdc-keyrock: Arc 0x5befab92a5a3d60f578cb51eeb4e4fd50a1e3123 holds USDC 0x3600000000000000000000000000000000000000 -> usdc-circle (wrapper); complete reviewed adapter census is one cirBTC-secured USDC lending market; https://app.morpho.org/arc/vault/0x5befab92a5a3d60f578cb51eeb4e4fd50a1e3123 and https://api.morpho.org/graphql. " +
      "arcusdc-galaxy: Arc 0x8e357432cc12ff425c36432f312968aeb16112af holds the same Arc USDC -> usdc-circle (wrapper); complete reviewed adapter census is one cirBTC-secured USDC lending market; https://app.morpho.org/arc/vault/0x8e357432cc12ff425c36432f312968aeb16112af and https://api.morpho.org/graphql. " +
      "armusdcs-wintermute: Ethereum 0xa2eaad0d586cf9fd73bb2c09cf6a7e3e187d68cd holds USDC 0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 -> usdc-circle (wrapper); complete reviewed census is six lender markets, not ownership of cbBTC/WBTC/wstETH/principal-token collateral; https://app.morpho.org/ethereum/vault/0xa2eaad0d586cf9fd73bb2c09cf6a7e3e187d68cd and https://api.morpho.org/graphql. " +
      "pendleusdc-pendle: Ethereum 0x55c1b6e461a6334b567baf0feb5d728715446f05 holds Ethereum USDC -> usdc-circle (wrapper); reviewed three lending markets secured by PT-reUSD-10DEC2026, PT-sUSDS-26NOV2026 and PT-sUSDE-26NOV2026, not holdings of those collateral tokens; https://app.morpho.org/ethereum/vault/0x55c1b6e461a6334b567baf0feb5d728715446f05 and https://api.morpho.org/graphql. " +
      "skymoneyusdsflagship-sky: Ethereum 0xe15fcc81118895b67b6647bbd393182df44e11e0 holds USDS 0xdc035d45d973e3ec169d2276ddab16f1e407384f -> usds-sky (wrapper); reviewed complete idle plus three lender-market census at block 26107702; https://sky.money/vaults. " +
      "skymoneyusdtsavings-sky: Ethereum 0x23f5e9c35820f4bab695ac1f19c203cc3f8e1e11 holds USDT 0xdac17f958d2ee523a2206206994597c13d831ec7 -> usdt-tether (wrapper); reviewed complete idle plus two sUSDS-secured lender-market census at block 26107702; https://sky.money/vaults. " +
      "sirloinusdc-steakhouse: Base 0xbeeff2490feffa212fac2f6553682c219e6a8845 holds USDC 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 -> usdc-circle (wrapper); reviewed sole same-asset MorphoMarketV1 adapter lending claim; https://app.morpho.org/base/vault/0xbeeff2490feffa212fac2f6553682c219e6a8845. " +
      "steakusdg-steakhouse: Robinhood 0xbeeff033f34c046626b8d0a041844c5d1a5409dd holds USDG 0x5fc5360d0400a0fd4f2af552add042d716f1d168 -> usdg-paxos (wrapper); reviewed sole same-asset MorphoMarketV1 adapter lending claim; https://app.morpho.org/robinhood-chain/vault/0xBeEff033F34C046626B8D0A041844C5d1A5409dd/steakhouse-usdg. " +
      "steakeurcv-steakhouse: Ethereum 0xbeef0c075da5d01112ae5cf34d257074fb5ddb2f holds EURCV 0x5f7827fdeb7c20b443265fc2f40845b715385ff2 -> eurcv-societe-generale-forge (wrapper); reviewed sole same-asset MorphoMarketV1 adapter lending claim; https://app.morpho.org/ethereum/vault/0xbeef0C075Da5D01112AE5cF34d257074fB5DDB2f. " +
      "kpkusdcyield-kpk: Ethereum 0xd5cce260e7a755ddf0fb9cdf06443d593aaeaa13 holds Ethereum USDC -> usdc-circle (wrapper); complete reviewed USDC lender-adapter census at block 26107704; https://app.morpho.org/ethereum/vault/0xd5cce260e7a755ddf0fb9cdf06443d593aaeaa13. " +
      "kpkusdcprime-kpk: Ethereum 0x4ef53d2caa51c447fdfeeedee8f07fd1962c9ee6 holds Ethereum USDC -> usdc-circle (wrapper); complete reviewed USDC lender-adapter census at block 26107704; https://app.morpho.org/ethereum/vault/0x4ef53d2caa51c447fdfeeedee8f07fd1962c9ee6. " +
      "gusdcq-galaxy: Ethereum 0x91600e31fbedc72433d4a57f16639cfe661be7d8 holds Ethereum USDC -> usdc-circle (wrapper); complete reviewed USDC lender-adapter census at block 26107704; https://app.morpho.org/ethereum/vault/0x91600e31fbedc72433d4a57f16639cfe661be7d8. " +
      "gusdtq-galaxy: Ethereum 0x71ffb6a81786ec285d429d531cf655107b9d878d holds Ethereum USDT -> usdt-tether (wrapper); complete reviewed USDT lender-adapter census at block 26107704; https://app.morpho.org/ethereum/vault/0x71ffb6a81786ec285d429d531cf655107b9d878d. " +
      "gtusdtp-gauntlet: Ethereum 0xf3557ad5e984211ac8a0874a670344f2c3376471 holds Ethereum USDT -> usdt-tether (wrapper); complete reviewed USDT lender-adapter census at block 26107704; https://app.morpho.org/ethereum/vault/0xf3557ad5e984211ac8a0874a670344f2c3376471. " +
      "steakcusdc-steakhouse: Ethereum 0xbeef00a59b577423653a1526c7009bde103f542b holds Ethereum USDC -> usdc-circle (wrapper); reviewed sole MorphoMarketV1AdapterV2 and complete lender-market inventory; https://app.morpho.org/ethereum/vault/0xbeef00a59b577423653a1526c7009bde103f542b. " +
      "bbqusdc-steakhouse-v2: Ethereum 0xbeeff2c5bf38f90e3482a8b19f12e5a6d2fca757 holds Ethereum USDC -> usdc-circle (wrapper); reviewed sole MorphoMarketV1AdapterV2 and complete lender-market inventory; https://app.morpho.org/ethereum/vault/0xbeeff2c5bf38f90e3482a8b19f12e5a6d2fca757. " +
      "cscbusdc-clearstar: Base 0x91c056b6d4311a743614fbc03ac32d4e6a2d3a3c holds Base USDC -> usdc-circle (wrapper); reviewed sole MorphoMarketV1AdapterV2 and complete lender-market inventory; https://app.morpho.org/base/vault/0x91c056b6d4311a743614fbc03ac32d4e6a2d3a3c. " +
      "ethenausdc-steakhouse: Base 0xbeeff0be997cca5b1c13a7433c2004637975739e holds Base USDC -> usdc-circle (wrapper); reviewed sole MorphoMarketV1AdapterV2 and complete lender-market inventory; https://app.morpho.org/base/vault/0xbeeff0be997cca5b1c13a7433c2004637975739e. " +
      "hyperusdca-hyperithm: Monad 0x78999cc96d2ba0341588c60ccb0e91c6c33cf371 holds USDC 0x754704bc059f8c67012fed69bc8a327a5aafb603 -> usdc-circle (wrapper); reviewed sole MorphoMarketV1AdapterV2 and complete lender-market inventory; https://app.morpho.org/monad/vault/0x78999cc96d2ba0341588c60ccb0e91c6c33cf371.",
    "2026-10-03",
    "Sol addition batch 2026-10-03 (orchestrated)",
  ),
  adapterReview("escrow-balance", "worker/src/cron/reserve-adapters/escrow-balance.ts", "Emits the single configured canonical escrowed asset for the pinned escrow contract.", "2026-08-12"),
  adapterReview("ethena-whitelabel", "worker/src/cron/reserve-adapters/ethena-whitelabel.ts", "Maps on-chain USDe/USDC custodian rows to canonical upstream IDs and leaves the Coinbase Prime off-chain custody balance unlinked.", "2026-09-09"),
  adapterReview("evm-branch-balances", "worker/src/cron/reserve-adapters/evm-branch-balances.ts", "Maps branch balances only from config entries carrying canonical coin IDs."),
  adapterReview("falcon", "worker/src/cron/reserve-adapters/falcon.ts", "Maps exact transparency asset labels through fixed reviewed tracked-stablecoin and tracked-RWA tables while leaving residual bucket exposure unlinked.", "2026-09-01"),
  adapterReview("flying-tulip-ftusd", "worker/src/cron/reserve-adapters/flying-tulip-ftusd.ts", "Maps only the reviewed Ethereum and Sonic USDC, USDT, and USSD collateral addresses to canonical upstream IDs.", "2026-08-09"),
  adapterReview("frax-balance-sheet", "worker/src/cron/reserve-adapters/frax.ts", "Uses the subject-aware reviewed Frax reserve mapping and suppresses self-links."),
  adapterReview("frax-fpi-collateral", "worker/src/cron/reserve-adapters/frax.ts", "Maps the reviewed FPI collateral roster to canonical upstream IDs."),
  adapterReview("gho", "worker/src/cron/reserve-adapters/gho.ts", "Maps only reviewed measured GSM reserve assets, retaining twelve-decimal percentages so positive USDC receipt claims are not rounded away. Issuance-only facilitator labels and the unresolved parent-facilitator collateral envelope remain unlinked; measured GSM holdings do not establish look-through weights for that residual.", "2026-09-30"),
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
  adapterReview("usdai-hub", "worker/src/cron/reserve-adapters/usdai-hub.ts", "Emits the fixed canonical PYUSD dependency at full weight after verifying the configured hub base token and measuring its on-chain balance.", "2026-09-01"),
  adapterReview("usdd-data-platform", "worker/src/cron/reserve-adapters/usdd-data-platform.ts", "Maps exact USDD reserve assets from the reviewed data-platform response. The Smart Allocator global portfolio is not attributable to the Tron SA001-A debt envelope without chain-scope and checkpoint reconciliation, so its named stablecoin holdings remain unlinked.", "2026-09-30"),
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
    reviewedAt: "2026-09-30",
    sourceFiles: ["worker/src/cron/reserve-adapters/united-por.ts"],
    rationale: "Preserves only an explicit configured dependency for the aggregate reviewed bucket. United's current proof-of-reserves source is genuinely single-bucket and does not publish constituent weights, so no token link is inferred.",
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
