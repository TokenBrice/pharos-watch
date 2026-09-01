import type { CaseStudy } from "./types";

export const content: CaseStudy = {
  slug: "buidl-tokenized-tbill-2025",
  eyebrow: "T-bill survivor",
  title: "BUIDL: the tokenized T-bill that held",
  subtitle:
    "BlackRock's BUIDL did the unglamorous thing a tokenized money-market fund is supposed to do: hold NAV, constrain access, disclose its structure, and become safer precisely because it was not pretending to be an ungated retail dollar.",
  lead: [
    "BUIDL, the BlackRock USD Institutional Digital Liquidity Fund tokenized by Securitize, launched in March 2024 as a regulated institutional fund share. It invests in cash, U.S. Treasury bills, and repurchase agreements, targets a stable $1 token value, and distributes yield through daily-accrued dividends paid monthly as new tokens. The price chart is intentionally boring.",
    "That boredom is the point. BUIDL survived the RWA boom without a peg drama because it accepted constraints that many DeFi-native dollars try to avoid: qualified-investor access, transfer controls, fund administration through Securitize, custody through BNY Mellon, and primary liquidity through institutional rails rather than permissionless instant exit for everyone. By March 2025 it had crossed $1B in assets, becoming the largest tokenized Treasury fund, and continued to be used as collateral and liquidity infrastructure by other protocols.",
    "The lesson is the positive control for tokenized T-bills. Safety did not come from a clever algorithm or a higher APY. It came from structure: short-duration government collateral, named intermediaries, daily NAV discipline, and gates that keep the token aligned with the fund it represents. BUIDL survived because it was willing to be a fund share first and a composable token second.",
  ],
  takeaways: [
    "BUIDL is a tokenized institutional fund share backed by cash, T-bills, and repos, with a target $1 NAV and daily-accrued dividends paid monthly.",
    "Its constraints are safety features: qualified access, transfer controls, named custody, and Securitize administration reduce the mismatch between fund liquidity and token liquidity.",
    "Crossing $1B AUM in March 2025 was not just growth; it showed institutional demand for tokenized T-bills that prioritize NAV discipline over permissionless reach.",
    "The contrast with USYC and USDR is structural: tokenized safe assets survive when pricing, redemption, and investor access are explicit rather than assumed away.",
  ],
  primaryCoinId: "buidl-blackrock",
  relatedCoins: [
    {
      coinId: "usyc-hashnote",
      note: "USYC is the wounded T-bill contrast. Like BUIDL, it is backed by short-duration Treasury exposure, but its downstream collateral use makes NAV, secondary liquidity, and oracle pricing a more visible stress surface.",
    },
  ],
  archetype: "tbill",
  outcome: "survived",
  eventDateLabel: "2024-2025",
  eventWindow: {
    startISO: "2024-03-20",
    endISO: "2025-03-13",
    peakDeviationBps: 0,
    lowPrice: 1,
  },
  timeline: [
    {
      dateISO: "2024-03-20",
      headline: "BlackRock launches BUIDL on Ethereum",
      body: "BlackRock launched its first tokenized fund on a public blockchain through Securitize. The fund was described as holding 100% of assets in cash, U.S. Treasury bills, and repurchase agreements, with a stable $1 token value and yield paid as daily-accrued monthly dividends.",
      severity: "high",
      href: "https://www.businesswire.com/news/home/20240320771318/en/BlackRock-Launches-Its-First-Tokenized-Fund-BUIDL-on-the-Ethereum-Network",
    },
    {
      dateISO: "2024-11-13",
      headline: "BUIDL expands beyond Ethereum",
      body: "Securitize and partners expanded BUIDL across additional networks, making the tokenized fund share more usable as institutional on-chain collateral without removing the transfer-agent and eligibility controls that define the product.",
      severity: "low",
      href: "https://securitize.io/learn/press/blackrocks-buidl-tokenized-by-securitize-launches-multi-chain",
    },
    {
      dateISO: "2025-03-13",
      headline: "BUIDL crosses $1B in AUM",
      body: "BUIDL surpassed $1B in assets under management and became the largest tokenized Treasury fund. Growth came with the NAV and redemption model intact rather than through a loosened peg promise or permissionless leverage loop.",
      severity: "low",
      href: "https://www.prnewswire.com/news-releases/blackrock-usd-institutional-digital-liquidity-fund-buidl-tokenized-by-securitize-surpasses-1b-in-aum-302401480.html",
    },
    {
      dateISO: "2025-11-13",
      headline: "BUIDL enters exchange-collateral workflows",
      body: "Securitize announced BUIDL support as collateral for trading on Binance and launched the fund on BNB Chain. The expansion showed the survivor's next risk frontier: broader collateral use must preserve the fund's controlled redemption and pricing assumptions.",
      severity: "med",
      href: "https://www.prnewswire.com/news-releases/blackrocks-buidl-tokenized-by-securitize-now-accepted-as-collateral-for-trading-on-binance-and-launches-on-bnb-chain-302613374.html",
    },
  ],
  sections: [
    {
      id: "what-buidl-is",
      heading: "What BUIDL is",
      paragraphs: [
        "BUIDL is not a retail payment stablecoin. It is the on-chain share class of an institutional liquidity fund. Investors subscribe through Securitize, assets are held in cash, Treasury bills, and repos, and the token is designed to maintain a stable $1 value while distributing fund income through additional tokens.",
        "The launch details that can sound limiting are the same details that make the structure resilient. The fund has a transfer agent, a custodian, eligibility checks, and a primary-market process. Those controls reduce the chance that secondary markets promise liquidity the underlying fund cannot actually provide.",
      ],
    },
    {
      id: "why-it-held",
      heading: "Why it held",
      paragraphs: [
        "BUIDL held because the token did not pretend every holder had an instant, ungated dollar claim in every context. The fund's value is rooted in short-duration government collateral and institutional redemption, not an AMM pool or a governance token subsidy. The token can move onchain, but its economic promise remains a fund-share promise.",
        "That structure trades reach for discipline. A permissionless user cannot necessarily treat BUIDL like USDC in every venue, and that is intentional. By keeping investor access, transferability, and redemption tied to fund administration, BUIDL avoids the maturity mismatch that killed USDR and the oracle/reuse ambiguity that wounded USYC-related collateral stacks.",
      ],
    },
    {
      id: "flat-chart-is-the-feature",
      heading: "The flat chart is the feature",
      paragraphs: [
        "Most case studies in this archive are about a violent price move. BUIDL is included because the absence of one is instructive. Tokenized Treasuries are supposed to be boring: the collateral is short duration, the NAV is explainable, and yield accrues through the fund rather than through reflexive token economics.",
        "The main risk is not that BUIDL's T-bills suddenly behave like volatile crypto collateral. The main risk is that downstream integrations could use BUIDL in contexts where fund-style redemption and transfer controls are misunderstood. As BUIDL becomes exchange collateral and cross-chain infrastructure, the survivor question shifts from 'does the fund hold NAV?' to 'do integrators preserve the constraints that make NAV meaningful?'",
      ],
    },
    {
      id: "lessons",
      heading: "Lessons",
      paragraphs: [
        "A tokenized T-bill can survive by being less composable than DeFi wants it to be. Investor restrictions, transfer controls, and formal fund administration are not cosmetic frictions; they are the mechanisms that keep the token's liquidity promise aligned with the assets underneath it.",
        "BUIDL is therefore the positive case for the `tbill` archetype. The safe version of a tokenized Treasury dollar is not the one with the highest yield or the broadest reach. It is the one where collateral, custody, NAV, redemption, and eligible holders all describe the same instrument.",
      ],
    },
  ],
  dataWidgets: [
    {
      kind: "peg-deviation",
      coinId: "buidl-blackrock",
      caption:
        "BUIDL on Pharos: the flat line is the point. A tokenized T-bill fund should read as NAV discipline, not as a volatile peg-defense drama.",
    },
  ],
  watchpoints: [
    "Whether new exchange-collateral and multichain integrations preserve BUIDL's fund-share controls rather than treating it like an unrestricted retail stablecoin.",
    "Primary redemption access, cutoff times, and any stress-period changes to settlement through Securitize or fund administration.",
    "Custody and collateral composition: cash, Treasury bills, and repos should remain short-duration and clearly disclosed.",
    "Oracle treatment in downstream protocols: BUIDL should be priced as a controlled NAV fund share with appropriate eligibility and liquidity assumptions.",
  ],
  crossLinks: [
    { href: "/learn/mechanisms/tbill/", label: "Mechanism: tokenized T-bill stablecoins" },
    { href: "/stablecoin/buidl-blackrock/", label: "BUIDL live data and risk" },
    {
      href: "/learn/case-studies/usyc-nav-pricing-2025/",
      label: "Case study: USYC and NAV-pricing basis risk",
    },
    {
      href: "/learn/case-studies/usdr-real-usd-2023/",
      label: "Case study: USDR and illiquid RWA backing",
    },
  ],
  sources: [
    {
      label: "BlackRock / BusinessWire: BUIDL launch",
      href: "https://www.businesswire.com/news/home/20240320771318/en/BlackRock-Launches-Its-First-Tokenized-Fund-BUIDL-on-the-Ethereum-Network",
    },
    {
      label: "Securitize: BUIDL product page",
      href: "https://securitize.io/blackrock/buidl",
    },
    {
      label: "Securitize / PR Newswire: BUIDL surpasses $1B AUM",
      href: "https://www.prnewswire.com/news-releases/blackrock-usd-institutional-digital-liquidity-fund-buidl-tokenized-by-securitize-surpasses-1b-in-aum-302401480.html",
    },
    {
      label: "Securitize: BUIDL launches multichain",
      href: "https://securitize.io/learn/press/blackrocks-buidl-tokenized-by-securitize-launches-multi-chain",
    },
    {
      label: "Securitize / PR Newswire: BUIDL collateral on Binance and BNB Chain",
      href: "https://www.prnewswire.com/news-releases/blackrocks-buidl-tokenized-by-securitize-now-accepted-as-collateral-for-trading-on-binance-and-launches-on-bnb-chain-302613374.html",
    },
  ],
  metaDescription:
    "BUIDL is the tokenized T-bill survivor: BlackRock/Securitize fund structure, $1 NAV discipline, controlled access, and collateral that stayed boring.",
  datePublished: "2026-06-18",
};
