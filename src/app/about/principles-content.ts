export interface PrincipleAxiom {
  id: string;
  title: string;
  body: string;
}

export const PRINCIPLES_AXIOMS: readonly PrincipleAxiom[] = [
  {
    id: "independence",
    title: "Independence is a precondition, not a marketing line.",
    body: "Pharos has no token, takes no issuer money, sells no paid placement, and accepts no editorial trade. Sustainability comes from community support and, eventually, paid API access for heavy programmatic users. The code is MIT-licensed and the inbound funding ledger is published in full at /funding/.",
  },
  {
    id: "risk-over-price",
    title: "Risk over price.",
    body: "Most trackers show what a stablecoin is worth right now. Pharos shows what could make it fail: backing, governance, freeze authority, dependency exposure, peg behavior, and exit liquidity. Price is the consequence; risk is the cause.",
  },
  {
    id: "reserves-vs-freeze",
    title: "Reserves do not matter if you can be frozen.",
    body: "A reserve schedule is a balance sheet, not a permission system. If the issuer can blacklist addresses, freeze contracts, or pause transfers, those reserves belong to a holder only until the issuer says otherwise. FreezeWatch exists for that reason, and blacklist exposure is a first-class input into every safety grade.",
  },
  {
    id: "por-theatre",
    title: "Real-time proof of reserves is theatre when the bank holds the keys.",
    body: "An attestation that is signed by, hosted by, and refreshed by the same entity that custodies the assets is a self-portrait. Pharos treats issuer-controlled feeds as opaque until a third party with no commercial dependency on the issuer can corroborate the read.",
  },
  {
    id: "decentralization-is-governance",
    title: "Decentralization is a property of governance, not branding.",
    body: "Pharos classifies stablecoins by where the actual permission to mint, freeze, pause, and reconfigure lives. A coin with a decentralized front end and a centralized fallback is CeFi-dependent, regardless of what the marketing says. The classification is a description of the infrastructure, not a courtesy to the issuer.",
  },
  {
    id: "yield-tokens-are-nav",
    title: "Yield-bearing stablecoins are NAV tokens, not stablecoins.",
    body: "A token designed to drift upward in value to capture yield is not pegged; it is a NAV instrument wearing the language of a stablecoin. Pharos flags these separately, withholds PegScore where the asset is not meant to hold a fixed price, and renders them in their own analytical surface.",
  },
  {
    id: "dependency-is-contagion",
    title: "Dependency is contagion.",
    body: "Safety grades cap composite scores at the upstream asset the coin depends on. A stablecoin backed by a stablecoin backed by a money-market fund inherits the worst grade in that chain, not the best. The dependency map exists because the 2023 USDC depeg showed that derivative coins move with their collateral, whether they want to or not.",
  },
  {
    id: "failed-coins-stay-visible",
    title: "Failed coins stay visible.",
    body: "When a tracked stablecoin effectively dies, Pharos freezes the detail page rather than deleting it. The cemetery is a research surface, not a memorial. A dashboard that quietly forgets its failures cannot be trusted with the ones that have not failed yet.",
  },
  {
    id: "methodology-versioned",
    title: "Methodology is versioned and dated.",
    body: "Every score Pharos publishes carries a methodology version and a changelog link. When a formula changes, the version increments and the change is documented before the new number replaces the old one. The project changes its mind in public so that anyone who cited an earlier reading can verify what changed between then and now.",
  },
  {
    id: "open-code-open-data",
    title: "Open code, open data, published curation.",
    body: "The dashboard, the worker pipeline, the scoring engines, and the data exports are MIT-licensed and reproducible. What is tracked is a curatorial decision, and the curation is published — additions land with explicit rationale, exclusions are documented when contested, and the inbound funding that supports the work is logged at /funding/ for inspection.",
  },
];

export const PRINCIPLES_AI_POLICY = {
  title: "On AI-authored content.",
  body: "Narrative summaries on coin pages and the daily digest are drafted by a large language model against the same data the dashboard renders. Each panel names the model and facts date; a reviewer is named only after approving that exact text. Static adoption, funding, address, TVL, supply, and market-cap claims require a displayed source, date, chain scope, and denominator. Address counts are not presented as users without a dedicated methodology, and project financing is not compared with token supply unless the quantities are economically comparable. The numeric outputs — scores, peg deviations, supply, liquidity, freezes — are computed by the worker pipeline, not by the model.",
} as const;

export const PRINCIPLES_CORRECTIONS = {
  title: "On corrections.",
  body: "Pharos publishes data that other people will cite, which means it has to be wrong in public when it is wrong. If a number is off, a classification is wrong, or a methodology choice does not survive scrutiny, the correction path is the same as for every Pharos data point: a GitHub issue, the on-page feedback link, or a message via Telegram. Verified corrections are applied and dated.",
} as const;
