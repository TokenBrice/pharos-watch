import { ARCHETYPE_VISUALS, type ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "rwa-credit-fund",
  headline: "Tokenize a private credit fund share",
  subtitle:
    "Regulated funds hold private credit, CLO tranches, or other non-Treasury debt; the token is a fund share whose NAV reflects credit losses and quarterly redemption gates.",
  lead: [
    "A tokenized credit fund token is a legal share in a regulated private-credit vehicle — not a money-market fund, not a Treasury bill fund. The underlying portfolio holds senior secured loans, CLO tranches, or other non-government debt instruments with meaningfully higher yield, meaningfully higher credit risk, and a redemption rail that is gated by design. Subscriptions are restricted to qualified purchasers or accredited investors via a transfer agent; redemption requests are queued and honored at the next NAV date, subject to a quarterly or monthly window and a fund-level redemption cap.",
    "The token sits between tokenized Treasuries and private equity on the risk spectrum. Yield is real and roughly 200–500 bps above the Treasury rate in normal market conditions. The cost of that spread is credit-default risk inside the portfolio, valuation opacity at the fund-administrator level, and a redemption gate that is the structural feature, not the emergency response.",
  ],
  howItWorks: [
    {
      title: "Institutional subscription",
      body: "A KYC/AML-verified accredited investor or qualified purchaser subscribes through a transfer agent — Securitize for the Apollo and Hamilton Lane funds, Anemoy for the Janus Henderson CLO, Tradable for the structured-receivable PC-series — with USD or an approved stablecoin. The fund manager deploys capital into senior secured loans, CLO tranches, direct-lending facilities, or structured receivables according to the disclosed mandate.",
    },
    {
      title: "Credit portfolio + NAV calculation",
      body: "The fund administrator marks the portfolio to model or to market and publishes a NAV, typically monthly or quarterly. The on-chain token accretes NAV as income is earned. Credit losses, defaults, or downward mark-to-markets flow directly into NAV; there is no separate equity tranche to absorb losses ahead of the token holder.",
    },
    {
      title: "Fund-share token, NAV-accruing",
      body: "The token is a legal fund share. Redemption requests are queued and honored at the next NAV publication, subject to a fund-level gate if aggregate redemptions exceed the fund's liquid buffer (typically 2–5% of NAV per quarter for diversified private-credit funds). Secondary-market liquidity exists only where a licensed marketplace operates, and transfers are restricted to whitelisted counterparties.",
    },
  ],
  riskProfile: [
    {
      headline: "Quarterly redemption gate under stress",
      body: "Redemption gates are a structural feature of private credit funds, not an emergency response. The canonical anchor is Blackstone's BREIT — a non-traded private-real-estate REIT, not a credit fund, but the same redemption-gate architecture. From November 2022 through February 2024, BREIT honored only the contractual cap of 2% of NAV per month and 5% of NAV per quarter; aggregate redemption requests overshot the cap for 15 consecutive months, and holders waited until early 2024 for queues to clear. Tokenized credit funds inherit the same structure: the gate is the design, not the failure.",
    },
    {
      headline: "Credit default and portfolio losses",
      body: "Unlike Treasuries, private credit can default. Senior secured loans recover well below par in stress scenarios; mezzanine tranches and CLO equity recover less; investment-grade CLO tranches above BBB have historically been protected, but the AAA tranche is not bankruptcy-remote in a sharp credit cycle. Losses flow into NAV without warning when the fund administrator updates marks.",
    },
    {
      headline: "Regulatory and transfer restrictions",
      body: "These are securities. Transfers are restricted to permissioned addresses; the transfer agent maintains the registry of record. Regulatory action against the issuer, transfer agent, or custodian can freeze token movement independently of the underlying portfolio performance. The on-chain token is a representation of an off-chain legal claim, and the legal claim is what ultimately settles.",
    },
    {
      headline: "Valuation opacity",
      body: "Private credit assets are marked to model, not to a transparent on-chain oracle. NAV publication lags portfolio events; downward marks can be deferred across reporting periods. Information asymmetry between the fund administrator and token holders is structurally larger than for any other tracked archetype on Pharos.",
    },
  ],
  representativeCoins: [
    {
      coinId: "acred-apollo-securitize",
      note: "Apollo Diversified Credit Fund tokenized via Securitize. Multi-strategy private credit including direct lending, structured credit, and performing credit; quarterly redemption window; qualified-purchaser only.",
    },
    {
      coinId: "acrdx-anemoy-apollo",
      note: "Anemoy's tokenized share class of Apollo Diversified Credit. Same underlying fund as ACRED through a different transfer agent.",
    },
    {
      coinId: "jaaa-janus-henderson-anemoy",
      note: "Janus Henderson AAA CLO ETF (JAAA) tokenized via Anemoy. Holders are exposed to the senior-most tranche of the CLO market; daily fund NAV in the underlying ETF, on-chain accrual via the wrapper.",
    },
    {
      coinId: "hlscope-hamilton-lane",
      note: "Hamilton Lane Senior Credit Opportunities Securitize Fund. Senior secured direct lending; quarterly redemption; institutional accreditation required.",
    },
    {
      coinId: "stac-securitize",
      note: "Securitize Tokenized AAA CLO Fund. Senior-most CLO tranches managed by Securitize Capital; comparable risk-return profile to JAAA, different transfer-agent stack.",
    },
    {
      coinId: "mapollo-midas",
      note: "Midas tokenized exposure to Apollo's diversified credit mandate. Permissionless secondary market; underlying redemption inherits the Apollo fund's quarterly gate.",
    },
    {
      coinId: "mf-one-midas",
      note: "Midas mF-ONE — wrapped exposure to Fasanara's private-credit fund. Multi-strategy short-duration private credit with monthly NAV.",
    },
    {
      coinId: "mglobal-midas-fasanara",
      note: "Midas Fasanara Global — a sibling Midas product on the same Fasanara fund family with a different mandate slice. Same redemption mechanics.",
    },
  ],
  variations: [
    {
      title: "Senior secured private credit",
      body: "ACRED, ACRDX, and HLSCOPE hold first-lien direct loans on private companies. Recovery expectations are highest in this sub-category; the spread above Treasuries is the smallest within the credit-fund cohort.",
    },
    {
      title: "CLO tranche tokens",
      body: "JAAA and STAC expose holders to the AAA-rated tranche of collateralized loan obligations. Investment-grade rated but subject to CLO structural complexity — the AAA tranche has never failed in a U.S. CLO, but it is not bankruptcy-remote in an extreme credit cycle.",
    },
    {
      title: "Multi-strategy and structured credit vaults",
      body: "The Midas family (mAPOLLO, mF-ONE, mGLOBAL, mRe7YIELD, mMEV, mHYPER) wraps fund-managed mandates with monthly or quarterly redemption schedules. The Tradable PC-series (PC0000031, PC0000033, PC0000089, PC0000101) tokenizes specific structured-finance receivables — rent financing, post-settlement legal financing — outside the diversified-fund template.",
    },
  ],
  whatToWatch: [
    "Redemption Backstop route family on `/stablecoin/[id]/`. Credit-fund tokens typically show off-chain issuer routing with a quarterly window and explicit gating language; the published settlement delay and daily redemption cap are the structural feature, not the failure mode.",
    "Yield Score (PYS) on `/yield/`. PYS separates Treasury-derived yield from credit-derived yield; excess yield above the T-Bill baseline is the credit spread, and it compounds both redemption-gate and default risk.",
    "V9 Backing evidence on the report card. Senior secured private credit and AAA CLO tranches are assessed through credit quality, seniority, enforceability, valuation, maturity/liquidity, custody, and recovery evidence; mezzanine, equity-tranche, and concentrated borrower exposure remain adverse facts.",
    "Proof-of-Reserves cadence and attestor tier on the detail page. Credit funds frequently rely on monthly or quarterly NAV reports from a fund administrator rather than daily attestations; Big 4 administrators publish more rigorous and timely marks than niche firms.",
    "Live Reserve view where available. A minority of credit-fund tokens expose live portfolio composition; most expose only the latest published NAV and a manager-disclosed allocation slice.",
    "Freezewatch surface on `/freezewatch`. These are securities — the transfer agent maintains the registry of record, and admin-controlled transfer restrictions are a structural feature; sudden registry actions surface here before they show up as a peg deviation.",
  ],
  crossLinks: [
    {
      href: "/learn/mechanisms/tbill/",
      label: "Sibling explainer: tokenized Treasury bill funds",
    },
    {
      href: "/stablecoins/backing/rwa/",
      label: "RWA-backed stablecoin directory",
    },
    {
      href: "/methodology/",
      label: "Methodology — how RWA collateral is evaluated in V9 Backing",
    },
    {
      href: "/yield/",
      label: "Yield-bearing stablecoins ranked by PYS",
    },
    {
      href: "/learn/case-studies/usd0pp-usual-2025/",
      label: "Case study: USD0++ and redemption-terms risk",
    },
    {
      href: "/learn/case-studies/pmusd-precious-metals/",
      label: "Case study: pmUSD's in-situ gold collateral",
    },
  ],
  visuals: ARCHETYPE_VISUALS["rwa-credit-fund"],
};
