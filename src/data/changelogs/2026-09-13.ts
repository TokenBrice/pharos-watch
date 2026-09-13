import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-09-07", to: "2026-09-13" },
  headline:
    "Live reserve sync is rebuilt end to end while a free, keyless Safety Score feed opens on the API.",
  fieldNotes:
    "The reserve pipeline got a full rebuild: every adapter was reviewed, production valuation defects were corrected, and independent reports now enter as hash-pinned manifests the Worker only verifies. The same week the API changed shape, with grades free for everyone and keys reserved for donors. Beneath both, a test audit replaced mock-shaped assertions with executed behavior, and a 57-finding security review was closed before release.",
  summary: [
    {
      label: "Live reserve rebuild",
      tag: "coverage",
      description:
        "Phases 0 to 4 of the live reserve upgrade: valuation defects fixed (USD0 decimals, fxUSD pricing), hash-pinned assurance reports for PYUSD, USDG, USDP, GUSD, BRLA and FDUSD, and Sui, Tezos, Cardano and Hedera transports.",
    },
    {
      label: "Safety Score 9.47 to 9.49",
      tag: "feature",
      description:
        "Inherited upstream reserve gaps count once per cause (open data points 1,280 to 733 on replay), unmapped live reserves cannot restore curated dependency weights, and DDR 4.5 reads the published mint posture.",
      href: "/methodology/scoring-changelog/",
    },
    {
      label: "Yield 8.43",
      tag: "feature",
      description:
        "Non-USD hurdles re-base onto the USD risk-free rate so a peg paying its own inflation earns no excess-yield credit (wiTRY 44 to 6); PYS is reframed as pay-for-risk with zone chips and an explicit non-recommendation.",
      href: "/methodology/yield-changelog/",
    },
    {
      label: "API access lanes",
      tag: "security",
      description:
        "GET /api/safety-grades serves one score and grade per coin without a key, self-serve key issuance is closed, and donors above USD 10 claim a non-expiring key by signing a Sign-In-With-Ethereum message.",
    },
    {
      label: "Security remediation",
      tag: "security",
      description:
        "A 57-finding review closed provider identity, freshness, supply completeness, scoring provenance and CI trust-boundary gaps; bad Chainlink rounds become evidence, and future or non-finite timestamps fail closed.",
    },
    {
      label: "Test and docs audit",
      tag: "infra",
      description:
        "Suites across worker, shared, src and scripts moved from SQL-shaped mocks and prose pins to SQLite-backed, executed-effect assertions; a corpus audit corrected 103 source-verified drift claims across 42 documents.",
    },
    {
      label: "DEX pool memory",
      tag: "coverage",
      description:
        "Liquidity Score 6.4 keeps staged pools for 14 days with prices pinned to 24 hours so coverage stops flip-flopping on crawl timing; 19 GeckoTerminal-only chains gained CoinGecko onchain ids for census.",
      href: "/methodology/liquidity-score-changelog/",
    },
    {
      label: "Site and publication",
      tag: "design",
      description:
        "Resources split into four nav columns, the palette ranks page intents above coin matches, the digest exposes its monthly archive, automatic X posting of daily graphics was retired, and versions cap at two decimals.",
    },
  ],
  stats: { totalCommits: 147 },
  commits: [
    { hash: "db308247", message: "fix: refresh reviewed Paxos discovery module pins" },
    { hash: "0348583b", message: "fix: expose partial supplemental yield failures in cron status" },
    { hash: "e97a52d9", message: "fix: resolve chain labels in mint burn reconciliation" },
    { hash: "b51581c7", message: "test: align release fixtures with security remediation contracts" },
    { hash: "be1b7b65", message: "refactor: keep security remediation helpers module-local" },
    { hash: "1ad48789", message: "docs: keep security release references reproducible" },
    { hash: "e1fbca92", message: "fix(security): remediate reviewed application and data integrity findings" },
    { hash: "897304ea", message: "chore(yield): state the NAV-anchor fallback's real trigger" },
    { hash: "40366a43", message: "fix(yield): let NAV-oracle anchors read the daily tier past the raw window" },
    { hash: "e9115d2a", message: "docs(yield): record the issuer-rail eligibility rule and its third-party boundary" },
    { hash: "c2c68bed", message: "fix(yield): remove the D1 query-cost regressions and bound the remaining deletes" },
    { hash: "a7d7c2db", message: "fix(yield): stop counting issuer-native rails against venue-tier coverage" },
    { hash: "1868ab43", message: "fix(yield): bound the history retention drain so it cannot blow the D1 CPU limit" },
    { hash: "c6e41f78", message: "docs(yield): attribute BOLD's drop to the source fix, not the history rewrite" },
    { hash: "b199b450", message: "docs(yield): record the finalized v8.43 movement, not the replayed estimate" },
    { hash: "a1b73982", message: "fix(yield): never attribute movement across a methodology version boundary" },
    { hash: "bca7bb2c", message: "chore(yield): satisfy the env-contract doc block and critical-coverage enrollment" },
    { hash: "3e0eef52", message: "refactor(yield): move the benchmark freshness classifier into shared" },
    { hash: "a746405c", message: "test(yield): dedupe test scaffolding and wire the workbench-fallback resolver" },
    { hash: "fd5d3e63", message: "fix(yield): close the review findings before release" },
  ],
};
