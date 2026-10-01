import type { ArchetypeContent } from "./types";

export const content: ArchetypeContent = {
  archetype: "shared-reserve",
  headline: "Several liabilities, one shared reserve",
  subtitle: "Protocol exchange access is an operational claim, not proof that each token owns an exclusive slice of the pool.",
  lead: [
    "A shared-reserve design issues several currency liabilities against a common reserve ledger. The pool's assets must cover the complete liability set, including tokens not tracked by Pharos. Counting the same reserve once for each token would hide the shared shortfall rather than measure backing.",
    "Mento's reserve-backed currencies belong to this model, but their live exchange routes differ. V2 FX tokens use Broker pools, while current USDm and EURm use V3 FPMM paths. Mento's CDP-backed currencies are a different design and remain CDPs; an issuer's unknown-symbol fallback is not evidence of reserve membership.",
  ],
  howItWorks: [
    { id: "protocol-exchange", title: "Exchange through the live protocol", body: "An exact deployed provider or pool supplies the mint, burn or exchange claim. A working quote can demonstrate an operational path, but not legal priority or arbitrary-notional liquidity." },
    { id: "common-reserve", title: "Assets in a common reserve", body: "Reserve assets are held at identified locations and support multiple liabilities. Allocation rights, other creditors and encumbrances determine how much can actually support each claim." },
    { id: "currency-liabilities", title: "Several currency tokens", body: "Different currency units share the reserve risk. A complete conservation review values the whole liability ledger on a reproducible basis; a token's exchange price alone does not close that ledger." },
  ],
  riskProfile: [
    { headline: "Unreconciled shared liabilities", body: "A reserve dashboard total without complete dated liabilities and pool membership does not establish full coverage. Common unknowns remain bounded for every member using that evidence." },
    { headline: "Allocation and reuse", body: "A statement that a pool backs a token does not prove exclusive backing, no other creditors, unencumbered assets or funded first loss." },
    { headline: "Custody and default recovery", body: "An onchain Safe proves a location, not independent signers, insolvency protection or a stressed recovery waterfall. Happy-path Broker exchange is not default recovery evidence." },
  ],
  representativeCoins: [
    { coinId: "audm-mento", note: "Reserve-backed V2 currency with a Broker exchange path to USDm; the shared reserve and legal-priority questions remain separate." },
    { coinId: "cadm-mento", note: "Uses the same shared-reserve mechanism rule, with exact-token route and custody evidence evaluated independently." },
    { coinId: "cusd-celo", note: "USDm is reserve-backed but its current V3 FPMM route must not be confused with deprecated V2 pools." },
    { coinId: "ceur-celo", note: "EURm shares reserve backing and uses its own current V3 claim and rate paths." },
  ],
  variations: [
    { id: "v2-fx-pools", title: "V2 FX exchange pools", body: "Mento FX liabilities can exchange against USDm through Broker pools. The exact live token/provider/pool binding matters, especially during deprecation." },
    { id: "v3-fpmm-pools", title: "V3 FPMM paths", body: "USDm and EURm use current FPMM paths. Evidence from a V2 FX quote cannot establish these deployments or their execution capacity." },
  ],
  whatToWatch: [
    "Full pool membership and liabilities, including externally listed currencies.",
    "Liability conservation and encumbrance/allocation components, not just reserve composition.",
    "Exact live route generation and token deployment during migrations.",
    "Issuer nondisclosure stays charged; it is not a not-applicable component.",
    "Token-specific evidence can change grades without changing the common mechanism rule.",
  ],
  crossLinks: [
    { href: "/methodology/#safety-scores-methodology", label: "Safety Scores: shared backing and unresolved evidence" },
    { href: "/learn/mechanisms/cdp/", label: "Compare borrower-backed CDPs" },
    { href: "/learn/mechanisms/fiat-cash/", label: "Compare custodial cash claims" },
  ],
};
