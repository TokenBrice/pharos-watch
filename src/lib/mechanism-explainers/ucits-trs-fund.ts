import type { ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "ucits-trs-fund",
  headline: "Own a fund share, not a cash reserve claim",
  subtitle: "Physical securities and total-return swaps can target a cash-like return without turning the portfolio into Treasury bills.",
  lead: [
    "A tokenized UCITS share is a proportional interest in an identified fund and share class. The fund may own physical securities while exchanging their returns through total-return swaps (TRS). The token records the share claim; it is not a separate dollar in a bank account or ownership of each portfolio security.",
    "The economic inventory includes securities, signed derivative marks, cash, and any sleeves outside the swaps. Gross equity values, swap notionals and collateral are not interchangeable. A published share-class NAV does not by itself reconcile every liability or prove that every portfolio sleeve is hedged.",
  ],
  howItWorks: [
    { id: "fund-subscription", title: "Subscribe to a share class", body: "An eligible investor subscribes through the fund's permitted rails. Exact share-class terms determine the investor's proportional claim, transfer restrictions and redemption rights." },
    { id: "physical-and-derivative-book", title: "Physical securities plus TRS", body: "The fund holds securities and uses signed swap agreements to exchange covered portfolio returns. Cash or money-market sleeves may remain outside the strategy; counterparty collateral and netting need their own evidence." },
    { id: "share-class-nav", title: "Tokenized fund units", body: "The administrator publishes the share-class NAV used for subscriptions and redemptions. Settlement follows fund terms and gates rather than a blanket instant 1:1 cash promise." },
  ],
  riskProfile: [
    { headline: "Incomplete hedge or reconciliation", body: "A strategy described in a prospectus is not a current complete hedge inventory. Uncovered sleeves, liabilities, valuation timing and signed marks can change the economic exposure." },
    { headline: "Counterparty and collateral loss", body: "Daily unwind provisions do not guarantee recovery after counterparty default. Current collateral, enforceable netting, reuse and encumbrance must be scoped separately." },
    { headline: "Custody and stressed recovery", body: "UCITS status and an appointed auditor are not substitutes for independently reconciled assets and liabilities or exact insolvency priority. Fund, custodian and redemption continuity can fail at different layers." },
  ],
  representativeCoins: [
    { coinId: "eursafo-spiko", note: "EURSAFO represents the exact EUR share class of SAFO, combining physical securities with a portfolio-wide TRS strategy; it is not a Treasury-only fund." },
  ],
  variations: [
    { id: "unswapped-sleeves", title: "Partially unswapped portfolios", body: "A cash or money-market sleeve may remain outside the swaps. Its presence does not establish how much of the current book is covered; complete component evidence remains necessary." },
  ],
  whatToWatch: [
    "The exact fund and share-class identity, not just the issuer or ticker.",
    "Separate NAV reconciliation, portfolio hedge and counterparty/collateral evidence in Backing.",
    "Signed derivative exposures: negative marks must never become positive reserve weights.",
    "Eligibility, redemption windows, settlement delay and default recovery terms.",
    "Bounded unknown components remain charged even when the share-class totals feed reports no unmapped reserve slices.",
  ],
  crossLinks: [
    { href: "/methodology/#safety-scores-methodology", label: "Safety Scores: reserve quality and local mechanism risk" },
    { href: "/learn/mechanisms/tbill/", label: "Compare tokenized Treasury funds" },
    { href: "/learn/mechanisms/synthetic-delta-neutral/", label: "Compare other hedged designs" },
  ],
};
