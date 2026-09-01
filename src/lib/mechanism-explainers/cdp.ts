import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "cdp",
  headline: "Mint debt against crypto collateral",
  subtitle:
    "Overcollateralized vaults issue stablecoin debt; positions liquidate when collateral falls below a safety ratio.",
  lead: [
    "A collateralized debt position (CDP) stablecoin is created when a user locks crypto worth more than the debt they want to issue. The protocol mints the stablecoin against the collateral. If the collateral falls below the configured safety ratio, anyone can liquidate the position by repaying the debt and seizing the collateral at a discount. The peg is held by a mix of arbitrage incentives, direct on-chain redemption, and (in many systems) a Peg Stability Module, or PSM, which exchanges the stablecoin 1:1 against an upstream stablecoin.",
    "The design moves reserve management on-chain and lets anyone inspect the books in real time. That transparency comes with three pinned dependencies: a working oracle, working liquidations, and working governance.",
  ],
  howItWorks: [
    {
      id: "crypto-collateral",
      title: "Crypto collateral",
      body: "A user deposits ETH, an LST, BTC, or, where allowed, another stablecoin into a vault. The minimum collateral ratio (110% for Liquity v1, 130-175% for most Maker vaults, system-set in Aave V3 for GHO) sets the safety buffer.",
    },
    {
      id: "vault-psm",
      title: "Vault / PSM",
      body: "The user mints stablecoin against the collateral up to the protocol's debt ceiling. Most systems also operate a PSM that swaps an upstream stablecoin (typically USDC) for the new stablecoin at 1:1. That second path tightens the peg in calm markets and imports upstream-stablecoin risk in stressed markets.",
    },
    {
      id: "stablecoin-minted-or-liquidated",
      title: "Stablecoin minted (or position liquidated)",
      body: "If collateral breaches the minimum ratio, the vault is liquidated. Maker auctions it; Liquity and BOLD absorb it through a Stability Pool, an on-chain pool that buys the seized collateral at a discount using deposited stablecoin; crvUSD soft-arbitrages it through LLAMMA, an internal AMM that continuously rebalances collateral across price bands rather than liquidating at a single threshold. On-chain redemption also lets holders swap the stablecoin for $1 of collateral from the riskiest vault, functioning as a hard price floor.",
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
      note: "Mints against any Aave V3 collateral with facilitator-managed limits and yield-bearing GHO Stability Modules (GSMs) that swap stataUSDC and stataUSDT 1:1 against GHO and import that upstream stablecoin risk by design.",
    },
    {
      coinId: "crvusd-curve",
      note: "Uses LLAMMA (Lending-Liquidating AMM Algorithm) to continuously arbitrage collateral inside an internal AMM rather than hard-liquidating at a threshold. PegKeepers deploy pre-minted crvUSD into Curve pools against multiple stablecoins to dampen deviations.",
    },
  ],
  variations: [
    {
      id: "pure-eth-only-cdp",
      title: "Pure ETH-only CDP",
      body: "LUSD and BOLD. The simplest, most legible exposure: ETH price falls, redemption activity rises, peg defended at $1 of ETH per token. Immutable code, no governance, no PSM. Single-asset concentration is the price of that simplicity.",
    },
    {
      id: "multi-collateral-cdp-psm",
      title: "Multi-collateral CDP with PSM",
      body: "DAI/USDS and GHO. The most common modern shape; PSMs make the peg feel tighter in calm markets and import upstream-stablecoin risk during stress. Pharos tracks each PSM coupling as a `mechanism` dependency edge.",
    },
    {
      id: "soft-liquidation-savings-wrappers",
      title: "Soft-liquidation and savings wrappers",
      body: "crvUSD's LLAMMA continuously arbitrages collateral between paired bands rather than liquidating at one threshold: collateral attrition during chop instead of a one-shot liquidation in a crash. sDAI, sUSDS, and scrvUSD wrap the underlying CDP stablecoin in a savings vault that routes protocol revenue to holders.",
    },
  ],
  whatToWatch: [
    "Active depeg cap on the Safety Score. Severe active depegs hard-cap the grade; for CDPs this is the most common failure mode.",
    "Chain, deployment, bridge, and oracle evidence in the V9 report card. Unresolved or weak infrastructure evidence can constrain the affected pillar or publication instead of receiving a generic Decentralization penalty.",
    "Redemption Backstop route family. CDPs usually show `collateral-redeem` or `psm-swap`. Liquity-style forks expose `liquity-v1` and `liquity-v2-branches` live adapters with on-chain capacity.",
    "V9 dependency exposure via PSMs. DAI ↔ USDC, GHO ↔ USDC/USDT, and USDS ↔ USDC are tracked as `mechanism` dependencies and bound the downstream claim under the current dependency policy.",
    "Economic Control evidence. Review the actual upgrade, mint, freeze, governance, timelock, and key-custody surfaces; V9 does not award a generic governance-label band.",
    "Live Reserve view. Systems with live-reserve telemetry (Maker, Liquity v1/v2, GHO, crvUSD) show the 4-hourly vault and PSM composition instead of a quarterly snapshot.",
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
    {
      href: "/learn/case-studies/dai-black-thursday/",
      label: "Case study: Dai's Black Thursday and PSM dependency",
    },
    {
      href: "/learn/case-studies/crvusd-exploit-trilogy/",
      label: "Case study: crvUSD's exploit trilogy",
    },
    {
      href: "/cemetery/",
      label: "Cemetery: historical CDP failures",
    },
  ],
  visuals: ARCHETYPE_VISUALS.cdp,
  decommissioned: [
    {
      name: "Kava USDX",
      date: "2022-06",
      obituary:
        "Cosmos-native multi-collateral CDP minting USDX against BTC, XRP, BNB, or KAVA. Peaked at $176M before UST's implosion exposed the design flaw: USDX had on-boarded UST as collateral. The peg cracked to $0.55 and never healed. The textbook example of collateral on-boarding rewriting solvency overnight.",
      coinId: "usdx-kava-usdx-2022-06",
    },
    {
      name: "Raft R",
      date: "2023-11",
      obituary:
        "CDP minting R against wstETH and rETH collateral. A smart-contract exploit drained $3.3M in ETH; the hacker netted only ~$1.6M due to a slippage error of their own. Raft halted minting, offered a 42% recovery plan, and was abandoned. Code surface, not collateral, was the failure point.",
      coinId: "r-raft-r-2023-11",
    },
    {
      name: "Prisma mkUSD",
      date: "2024-11",
      obituary:
        "LST-backed CDP that took an $11.6M exploit in March 2024 and never recovered confidence. Governance approved PIP-46 to decommission the protocol: debt ceiling to zero and a PSM-style wind-down. A controlled funeral, but a funeral.",
      coinId: "mkusd-prisma-mkusd-2024-11",
    },
    {
      name: "Legacy BOLD",
      date: "2025-02",
      obituary:
        "The first casualty of Liquity v2's own immutability principle. A Stability Pool vulnerability surfaced weeks after launch. The contracts could not be patched, so the team redeployed everything from scratch. Immutable code is a feature until the bug appears.",
      coinId: "l-bold-legacy-bold-2025-02",
    },
    {
      name: "JPEG'd PUSD",
      date: "2024-06",
      obituary:
        "CDP that minted against NFT collateral. Declined alongside the NFT market itself; the protocol token stopped trading and the project was effectively abandoned. Collateral concentration in an illiquid asset class did exactly what the risk surface predicted.",
      coinId: "pusd-jpeg-d-pusd-2024-06",
    },
    {
      name: "US Permissionless Dollar",
      date: "2025-12",
      obituary:
        "Over-collateralized stETH CDP exploited via a \"Clandestine Proxy In the Middle of Proxy\" attack in December 2025, allowing the attacker to mint ~98M fraudulent USPD and drain ~237 stETH. Legitimate supply never exceeded $500K; the proxy admin surface was where the design failed, not the collateral.",
      coinId: "uspd-us-permissionless-dollar-2025-12",
    },
    {
      name: "YU (Yala)",
      date: "2025-11",
      obituary:
        "BTC-backed CDP that survived its first death: a September 2025 mint-authorization exploit produced 120M unauthorized YU, and the team injected $5.5M to claw back the peg. Two months later, runaway borrowing drained all liquidity pools and YU collapsed to $0.44. The mint surface was patched; the bank-run surface was not.",
      coinId: "yu-yu-2025-11",
    },
  ],
};
