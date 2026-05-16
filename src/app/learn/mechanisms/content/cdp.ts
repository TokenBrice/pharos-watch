import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "cdp",
  headline: "Mint debt against crypto collateral",
  subtitle:
    "Overcollateralized vaults issue stablecoin debt; positions liquidate when collateral falls below a safety ratio.",
  lead: [
    "A collateralized debt position (CDP) stablecoin is created when a user locks crypto worth more than the debt they want to issue. The protocol mints the stablecoin against the collateral. If the collateral falls below the configured safety ratio, anyone can liquidate the position by repaying the debt and seizing the collateral at a discount. The peg is held by a mix of arbitrage incentives, direct on-chain redemption, and (in many systems) a Peg Stability Module — a PSM, which exchanges the stablecoin 1:1 against an upstream stablecoin.",
    "The design moves reserve management on-chain and lets anyone inspect the books in real time. That transparency comes with three pinned dependencies: a working oracle, working liquidations, and working governance.",
  ],
  howItWorks: [
    {
      title: "Crypto collateral",
      body: "A user deposits ETH, an LST, BTC, or — where allowed — another stablecoin into a vault. The minimum collateral ratio (110% for Liquity v1, 130–175% for most Maker vaults, system-set in Aave V3 for GHO) sets the safety buffer.",
    },
    {
      title: "Vault / PSM",
      body: "The user mints stablecoin against the collateral up to the protocol's debt ceiling. Most systems also operate a PSM that swaps an upstream stablecoin (typically USDC) for the new stablecoin at 1:1. That second path tightens the peg in calm markets and imports upstream-stablecoin risk in stressed markets.",
    },
    {
      title: "USDX minted",
      body: "If collateral breaches the minimum ratio, the vault is liquidated — auctioned (Maker), absorbed by a Stability Pool — the on-chain pool that buys the seized collateral at a discount using deposited stablecoin (Liquity, BOLD) — or soft-arbitraged by an internal AMM (LLAMMA for crvUSD, which continuously rebalances collateral across price bands rather than liquidating at a single threshold). On-chain redemption also lets holders swap the stablecoin for $1 of collateral from the riskiest vault, functioning as a hard price floor.",
    },
  ],
  riskProfile: [
    {
      headline: "Liquidation cascade in a fast collateral crash",
      body: "On 12 March 2020 (\"Black Thursday\"), ETH fell roughly 50% over a 24-hour window, gas prices spiked above 200 gwei, and Maker's auction-keeper system processed liquidations at near-zero bids because rival keepers could not get transactions confirmed. Per MakerDAO's own post-mortem, the protocol ended up with a shortfall of more than 5.4M DAI and ran a series of debt auctions that minted and sold 20,980 MKR for ~5.3M DAI to recapitalize the system. Liquidation infrastructure is part of the peg, not separate from it.",
    },
    {
      headline: "Oracle failure or manipulation",
      body: "Liquidations trigger on an oracle price. A stale, manipulated, or single-source price can liquidate solvent positions or let insolvent ones escape. Modern systems use medianizers and circuit breakers; older designs were vulnerable to flash-loan attacks on thin oracles.",
    },
    {
      headline: "Governance and PSM attack surface",
      body: "A CDP that can on-board new collateral types via governance vote can have its solvency rewritten faster than its risk team can react. PSMs additionally hard-couple the stablecoin to upstream tokens (USDC for DAI, sUSDC/sUSDT for GHO), so any upstream depeg shows up on the CDP's books.",
    },
    {
      headline: "Collateral concentration",
      body: "Single-asset CDPs (LUSD: 100% ETH; BOLD: WETH + wstETH + rETH only) inherit the concentration risk of that asset. Multi-collateral systems trade that risk for governance complexity.",
    },
  ],
  representativeCoins: [
    {
      coinId: "dai-makerdao",
      note: "Multi-collateral CDP plus a LitePSM that swaps 1:1 against USDC. Reserve mix is dominated by the USDC PSM and RWA / lending vaults, with on-chain crypto collateral now a minority share; live composition is visible in the Live Reserve view.",
    },
    {
      coinId: "usds-sky",
      note: "The upgraded DAI: 1:1 swappable to DAI, same vault and PSM system, governed by Sky. Peg defended by PSMs against USDC and DAI.",
    },
    {
      coinId: "lusd-liquity",
      note: "Immutable code, ETH-only collateral, 110% minimum collateral ratio, on-chain redemption for $1 of ETH, Stability Pool absorbs liquidations. No governance, no admin keys, no PSM.",
    },
    {
      coinId: "bold-liquity",
      note: "Liquity v2: also immutable, ETH-collateral only (WETH/wstETH/rETH), user-set borrower interest rates routed to Stability Pool depositors. Direct on-chain redemption for $1 of collateral from the riskiest branch.",
    },
    {
      coinId: "gho-aave",
      note: "Mints against any Aave V3 collateral with facilitator-managed limits and yield-bearing GHO Stability Modules — GSMs — that swap stataUSDC and stataUSDT 1:1 against GHO and import that upstream stablecoin risk by design.",
    },
    {
      coinId: "crvusd-curve",
      note: "Uses LLAMMA — Lending-Liquidating AMM Algorithm — to continuously arbitrage collateral inside an internal AMM rather than hard-liquidating at a threshold. PegKeepers deploy pre-minted crvUSD into Curve pools against multiple stablecoins to dampen deviations.",
    },
  ],
  variations: [
    {
      title: "Pure ETH-only CDP",
      body: "LUSD and BOLD. The simplest, most legible exposure: ETH price falls, redemption activity rises, peg defended at $1 of ETH per token. Immutable code, no governance, no PSM. Single-asset concentration is the price of that simplicity.",
    },
    {
      title: "Multi-collateral CDP with PSM",
      body: "DAI/USDS and GHO. The most common modern shape; PSMs make the peg feel tighter in calm markets and import upstream-stablecoin risk during stress. Pharos tracks each PSM coupling as a `mechanism` Dependency Risk.",
    },
    {
      title: "Soft-liquidation and savings wrappers",
      body: "crvUSD's LLAMMA continuously arbitrages collateral between paired bands rather than liquidating at one threshold — collateral attrition during chop instead of a one-shot liquidation in a crash. sDAI, sUSDS, and scrvUSD wrap the underlying CDP stablecoin in a savings vault that routes protocol revenue to holders.",
    },
  ],
  whatToWatch: [
    "Active depeg cap on the Safety Score. Severe active depegs hard-cap the grade; for CDPs this is the most common failure mode.",
    "Chain tier and oracle dependency in the report card. Non-Ethereum CDP deployments carry an explicit chain-infra penalty on Decentralization.",
    "Redemption Backstop route family. CDPs usually show `collateral-redeem` or `psm-swap`. Liquity-style forks expose `liquity-v1` and `liquity-v2-branches` live adapters with on-chain capacity.",
    "Dependency Risk via PSMs. DAI ↔ USDC, GHO ↔ USDC/USDT, USDS ↔ USDC are tracked as `mechanism` dependencies — the upstream stablecoin's grade ceilings the CDP's.",
    "Governance Quality tier. `immutable-code` (LUSD, BOLD) sits at the top; `dao-governance` (DAI, USDS, GHO, crvUSD) drops a band; `multisig` drops further.",
    "Live Reserve view. Systems with `liveReservesConfig` (Maker, Liquity v1/v2, GHO, crvUSD) show the 4-hourly vault and PSM composition instead of a quarterly snapshot.",
  ],
  crossLinks: [
    {
      href: "/methodology/#safety-scores-methodology",
      label: "Safety Score methodology",
    },
    {
      href: "/methodology/#liquidity-methodology",
      label: "Liquidity Score methodology",
    },
    {
      href: "/stablecoins/infrastructure/liquity-v1/",
      label: "Liquity v1 fork directory",
    },
    {
      href: "/dependency-map/",
      label: "Dependency map: PSM couplings",
    },
    {
      href: "/learn/mechanisms/synthetic-delta-neutral/",
      label: "Synthetic delta-neutral explainer",
    },
  ],
  visuals: ARCHETYPE_VISUALS.cdp,
};
