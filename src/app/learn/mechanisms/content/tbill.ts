import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "tbill",
  headline: "Tokenized T-Bill funds with daily NAV",
  subtitle:
    "Regulated funds hold short-duration Treasuries; the token is a fund share that accretes NAV instead of trading exactly at $1.",
  lead: [
    "T-Bill / RWA fund tokens are the on-chain wrapper around a regulated short-duration government-securities fund. Subscriptions come in as USD or a permitted stablecoin; the fund deploys into U.S. T-Bills, overnight repos, and cash; the token represents a fund share whose net asset value (NAV) rises every day by roughly the prevailing risk-free rate. Most of these tokens are explicitly not pegged to $1.00 — they are NAV-accruing fund shares with a daily price published by the fund administrator.",
    "Closer to a tokenized Treasury bond ETF than to a checking account. Yield is real, but redemptions run through a transfer agent (the fund's registrar of record), holdership is whitelisted, and secondary-market liquidity is thinner than in fiat-cash stablecoins.",
  ],
  howItWorks: [
    {
      title: "Investor cash",
      body: "A KYC-verified investor — typically a Qualified Purchaser (a U.S. accreditation tier above accredited investor that requires roughly $5M+ in investments) or an accredited investor — subscribes USD through a transfer agent such as Securitize or NAV Consulting. Some funds also accept tokenized USDC and convert inside the fund.",
    },
    {
      title: "T-Bills + Repos",
      body: "The fund deploys cash into short-duration U.S. T-Bills, overnight reverse-repos, and a small cash buffer. The administrator publishes a daily NAV; the on-chain token records the holder list and accretes yield.",
    },
    {
      title: "USDX units",
      body: "The token is minted or rebased pro-rata. BENJI rebases share count daily so per-token value stays near $1.00; BUIDL accrues by minting new units; USDY and OUSG appreciate by per-token price. Redemption is bank-wire or stablecoin-out, settled at NAV.",
    },
  ],
  riskProfile: [
    {
      headline: "Duration mismatch in a yield-curve shock",
      body: "Short-duration Treasury funds still carry mark-to-market risk. A sharp jump in short rates pushes T-Bill prices below par; the fund recovers at maturity, but redemption pricing during the shock is at the depressed NAV.",
    },
    {
      headline: "Redemption gating and transfer restrictions",
      body: "These are securities, not cash. Transfers are restricted to whitelisted addresses; primary-market redemption can be paused, queued, or settled T+N. In a stressed market this matters more than the underlying asset risk.",
    },
    {
      headline: "Custodian and fund-administrator failure",
      body: "The token is only as good as the off-chain legal claim. BNY Mellon custodies BUIDL; Anchorage Digital Bank — an OCC-chartered national bank — issues and holds USDtb's reserves. If the custodian is impaired, or the transfer agent fails, the on-chain token becomes a claim on a frozen legal structure.",
    },
    {
      headline: "Bridge layer mismatch",
      body: "Several products keep the fund-share registry on a single chain and bridge token representations via LayerZero OFT or another third-party bridge. A bridge failure can suspend cross-chain transfers without affecting the underlying fund.",
    },
  ],
  representativeCoins: [
    {
      coinId: "buidl-blackrock",
      note: "BlackRock's institutional money-market fund issued under SEC Reg D. Majority short Treasuries with a repo and cash float. Custodied at BNY Mellon, administered by Securitize.",
    },
    {
      coinId: "benji-franklin-templeton",
      note: "On-chain share record for Franklin Templeton's FOBXX, an SEC-registered U.S. government money market fund. Stable $1.00 NAV; yield distributed by daily rebasing of share count.",
    },
    {
      coinId: "usdy-ondo-finance",
      note: "NAV-appreciating dollar token backed by short Treasuries, iShares Short Treasury Bond ETF shares, and bank demand deposits. Permissioned for non-U.S. investors; bank-wire redemption at daily NAV.",
    },
    {
      coinId: "ousg-ondo-finance",
      note: "NAV-accreting share class for U.S. Qualified Purchasers. Reserves are mostly BUIDL with a smaller BlackRock FedFund and USDC liquidity float. Instant T+0 mint/redeem against USDC via OUSGInstantManager; whitelisted transfer only.",
    },
    {
      coinId: "usdtb-ethena",
      note: "Fiat-cash-style mint/redeem with reserves mostly in BUIDL plus a USDC float. Issued by Anchorage Digital Bank under OCC supervision. Designed as the calm reserve asset behind USDe.",
    },
  ],
  variations: [
    {
      title: "Tokenized money-market funds with stable $1 NAV",
      body: "BENJI and similar share tokens operate as $1-stable funds where yield is paid out by rebasing share count. UX looks fiat-cash; the legal wrapper is a fund.",
    },
    {
      title: "NAV-accreting fund shares",
      body: "BUIDL, USDY, OUSG, and USYC let per-unit price drift up over time. Pharos flags these with `navToken` and shows \"NAV\" instead of bps on peg-deviation tables — price drift is signal, not depeg.",
    },
    {
      title: "Hybrid yield-bearing stablecoins",
      body: "USDtb (Ethena) and the M0-built family use T-Bill reserves to back a token that does target $1. The exit rail differs from a pure NAV token; the reserve mechanics are the same.",
    },
  ],
  whatToWatch: [
    "NAV-tag treatment on the peg table — `navToken: true` coins show \"NAV\" rather than bps in the peg-deviation column.",
    "Reserve composition on `/stablecoin/[id]/` — these should be majority `very-low` risk (Treasuries, repos, cash). Anything else is unusual.",
    "Redemption Backstop route family — most NAV tokens show `offchain-issuer` with bank-wire settlement; watch `settlementDelaySec`, `dailyLimitUsd`, `minRedeemUsd`, and `holderEligibility`.",
    "Yield Score (PYS) on `/yield` — PYS rewards consistent Treasury-derived yield over reward-heavy or single-source-dependent venues.",
    "`navToken` exclusion from DEWS — DEWS skips NAV tokens; the closest equivalent stress signal is the Redemption Backstop snapshot and issuer reserve cadence.",
    "Proof-of-Reserves attestor tier and cadence on the detail page — `big4` with daily NAV is the gold standard for tokenized funds; `niche` is acceptable but slower to respond.",
  ],
  crossLinks: [
    {
      href: "/methodology/#yield-intelligence-methodology",
      label: "Yield Intelligence methodology — how PYS handles NAV tokens",
    },
    {
      href: "/methodology/#safety-scores-methodology",
      label: "Safety Scores methodology — how RWA collateral is weighted in Resilience",
    },
    { href: "/yield/", label: "Yield-bearing stablecoins ranked by PYS" },
    {
      href: "/stablecoins/backing/rwa-backed/",
      label: "RWA-backed stablecoin directory",
    },
    {
      href: "/learn/mechanisms/fiat-cash/",
      label: "Sibling explainer: cash-backed stablecoins",
    },
  ],
  visuals: ARCHETYPE_VISUALS.tbill,
};
