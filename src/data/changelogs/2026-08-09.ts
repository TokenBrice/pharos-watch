import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-08-03", to: "2026-08-09" },
  headline:
    "Mint Authority and Exit fold into Safety Score V9, the V8 engine is retired, and 25 reserve proofs are corrected.",
  fieldNotes:
    "Consolidation week. Three separate scoring engines (mint authority, exit, and the V8 core) stopped existing as independent code and became pillars of one published model. The reserve work cut the other way: dozens of proof-of-reserves records were downgraded to what the evidence actually supports. Coin pages now show the unified scoring model alongside those evidence-bounded reserve assessments.",
  summary: [
    {
      label: "Mint authority folded in",
      tag: "feature",
      href: "/methodology/scoring-changelog/",
      description:
        "Safety Score 9.1 merges mint grading into the control pillar and deletes the standalone Mint Authority engine. Curated postures became validated annotations, and 113 supervised issuers were re-evidenced.",
    },
    {
      label: "One exit engine",
      tag: "feature",
      href: "/methodology/scoring-changelog/",
      description:
        "Redemption methodology v4.3 consolidates exit scoring: the legacy effective score and the shadow same-notional engine are gone, the Selector reads the published V9 Exit pillar, and ladder boundaries unify on at-or-above.",
    },
    {
      label: "V8 retired",
      tag: "infra",
      href: "/methodology/scoring-changelog/",
      description:
        "Scoring now runs on a native v4 input bound to the V9 evaluation build, with envelope v2 identity and a replay diff comparator gating the cutover. The V8 engine and its manifest were deleted outright.",
    },
    {
      label: "Honest reserve proofs",
      tag: "coverage",
      description:
        "A phased proof-of-reserves sweep corrected 25 overstated records and refreshed majors, regional issuers, and DeFi dashboards in lockstep. A new guard stops PoR and composition dates drifting apart again.",
    },
    {
      label: "Coin page rebuild",
      tag: "design",
      description:
        "Stablecoin detail pages gained custody, regulatory-standing, and oracle and liquidation sections, plus unified evidence modules drawn on control rails, hash-aware folds, and a new Bridging module.",
    },
    {
      label: "Wave-1 curation",
      tag: "coverage",
      description:
        "Research landed 121 mechanism overlays, control and access reviews across the C01-C12 set, reserve composition curation for 79 coins, and wave-3 long-tail dossiers. syrupUSDC is now an RWA credit fund.",
    },
    {
      label: "Deeper DEX discovery",
      tag: "infra",
      href: "/methodology/liquidity-score-changelog/",
      description:
        "DEX discovery registered verified providers for 50 deployment chains, added a Stellar Horizon provider with sweep-aware census bounds, reported complete DexScreener pool counts, and made oversized sweeps resumable.",
    },
    {
      label: "Coverage and editorial",
      tag: "coverage",
      description:
        "Tori trUSD and JPYSC were promoted to active tracking, the v9.14 commodity-claim archetype migrated gold-backed assets onto a shared model, and 40 AI editorial summaries were rewritten against the current scoring set.",
    },
    {
      label: "ftUSD evidence correction",
      tag: "coverage",
      href: "/stablecoin/ftusd-flying-tulip/",
      description:
        "Corrected Ethereum-only supply and address scope, removed the financing-to-supply comparison, documented the perpetual PUT, refreshed both live borrow-and-stake strategies, distinguished 3-of-5 Safe control from entity concentration, and updated Safe-module and issuer reserve-source evidence. The valid dependency, liquidation, smart-contract, upgradeability, no-timelock, and independent-assurance risks remain.",
    },
  ],
  stats: { totalCommits: 127 },
  commits: [
    { hash: "5c388019", message: "feat(detail): mount oracle section and in-flow custody/regulatory copies" },
    { hash: "8bf84ee2", message: "feat(detail): register custody and regulatory-standing cards in the summary rail" },
    { hash: "f21ff154", message: "feat(detail): project custody and oracle reviews onto the client coin" },
    { hash: "14c1cedc", message: "feat(detail): oracle-risk projection and oracle & liquidation section" },
    { hash: "cc19c970", message: "feat(detail): regulatory-standing view builder and rail card" },
    { hash: "0cde6d03", message: "feat(detail): custody projection and rail card component" },
    { hash: "79f632a3", message: "fix(safety-score): restore migrated commodity overlays' original evidence dates (#807)" },
    { hash: "592af2ca", message: "release(v9.14): commodity-claim archetype migration + unknown-resolver follow-up queue (#806)" },
    { hash: "90eb1c33", message: "chore(pages): raise representative detail pageTxt ceiling for wave-1 content" },
    { hash: "ebe1340c", message: "test(prices): assert the address-lookup invariant, not the deployment pick" },
    { hash: "9b7de63e", message: "test(prices): re-pin fallback address-lookup URL after near DS registration" },
    { hash: "ba086264", message: "chore(release): gate remediations - reviewed gitleaks identifiers, doc-sync, cemetery refresh" },
    { hash: "1134ab32", message: "fix(data): restore FreezeWatch inherited verdicts the C-wave over-suppressed" },
    { hash: "3f020d18", message: "test(data-contracts): reconcile frontend/script pins with the wave stack" },
    { hash: "a2e839c0", message: "chore(lint): drop unused CG_CHAINS destructure in rotation test" },
    { hash: "2cac2854", message: "chore(safety-score): retire stale adverse anchor pins (MIM frozen, U pre-drifted)" },
    { hash: "73a96821", message: "data(reserves): converge usdk-kast to the honest M0 residual (owner ruling)" },
    { hash: "fcef3059", message: "test(safety-score): advance replay CLI test clock past wave-1 review dates" },
    { hash: "8a96b89f", message: "data(long-tail): apply wave-3 dossiers + reconcile deferred contract tests" },
    { hash: "2a1e9bc4", message: "feat(safety-score): commodity-claim archetype engine (v9.14 phase 1)" },
  ],
};
