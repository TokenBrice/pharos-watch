import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-09-21", to: "2026-09-22" },
  headline:
    "A 225-commit holistic review makes unavailable data fail closed repo-wide, and Safety Score 9.9 moves USDT to 73/B.",
  fieldNotes:
    "Six waves of the 2026-09-21 holistic review land as one branch: correctness, hardening, reliability, deduplication, test quality, then the records. The recurring defect was optimism, an absent reading published as zero and a failed read as healthy, and the repair is now written down as ADR-28 to ADR-35 rather than left to review. Evidence-backed chain-maturity gates cost USDT its A+ on the frozen capture, which is the point.",
  summary: [
    {
      label: "Fail-closed data contracts",
      tag: "security",
      description:
        "The P0 and P1 waves replaced optimistic defaults across supply, DEWS, yield, freeze, blacklist and route-status producers: an unavailable observation publishes null and a reason, never zero, healthy or open.",
    },
    {
      label: "Safety Score 9.91",
      tag: "feature",
      description:
        "Five versions since 9.5: chain maturity became a clock-bound, citation-backed admission and assurance reports expire 100 days after their period end, moving USDT 87/A+ to 73/B on the frozen review capture.",
      href: "/methodology/scoring-changelog/",
    },
    {
      label: "Pricing 6.24 and 6.25",
      tag: "feature",
      description:
        "A promoted DEX protocol lane enters primary consensus only when that individual lane is corroborated, and wclp-ripio gains a direct CoinGecko CLP quote behind a registry-guarded native-peg map.",
      href: "/methodology/pricing-pipeline-changelog/",
    },
    {
      label: "DEWS 6.23 and 6.24",
      tag: "feature",
      description:
        "Absent evidence no longer scores as measured calm: an unmapped price-confidence tier takes the worst value and smoothing needs a prior reading, and a degraded run no longer advances the published generation.",
      href: "/methodology/depeg-changelog/",
    },
    {
      label: "Liquidity, backstop and PSI",
      tag: "feature",
      description:
        "Liquidity 6.6 records the concentration bands September's card consolidation shipped without an entry, backstop 4.43 requires same-run route evidence for a live status, and PSI 3.62 replays supply as-of the day.",
      href: "/methodology/",
    },
    {
      label: "Cron and retention bounds",
      tag: "infra",
      description:
        "Every retention delete and unbounded read is bounded, slot fencing stops one slow head abandoning its chain, each degraded run names a machine-readable reason, and four additive migrations land first.",
    },
    {
      label: "Telegram and digest delivery",
      tag: "infra",
      description:
        "Delivery gains fencing, backoff and ingress guards, the risk-alert SLO is enforced at the 1,000-watcher tier the planner actually meets, and digest edition numbers derive from the full non-blocked history.",
    },
    {
      label: "Deduplication and test lanes",
      tag: "coverage",
      description:
        "Shared contracts got single owners and the oversized V9, Telegram and yield modules split leafward, taking the clone ratchet from 7,568 to 3,073 duplicated lines; nine test lanes replaced pins with outcomes.",
    },
    {
      label: "AZND and XTUSD frozen",
      tag: "coverage",
      description:
        "Mu Digital AZND freezes after the issuer's July 10 wind-down announcement left only a ~$767 Curve pool near $0.03, and XTUSD freezes after XT.com's official market went stale on July 18 with an empty book and no admissible route. Both keep archived detail pages and cemetery records.",
    },
    {
      label: "Freeze-day supply cliff is honest",
      tag: "infra",
      description:
        "AZND's published $16.3M circulating equals the CoinGecko token count rather than USD value; the aggregate drops that phantom figure when the freeze takes effect, an honest cliff explained here rather than smoothed over.",
    },
  ],
  stats: { totalCommits: 225 },
  commits: [
    { hash: "415896d6", message: "Docs: test-volume, gitleaks-ratchet and D1-capacity numbers carry their producing commands and commits" },
    { hash: "7a626767", message: "Docs: contract drift corrected and eight product/policy decisions recorded" },
    { hash: "27e224a9", message: "Docs: the eight repo-wide data-integrity rules recorded as ADR-28 to ADR-35" },
    { hash: "c52131d0", message: "Yield venue staleness scan covers dependency-concentration entries; cadence documented as quarterly" },
    { hash: "d319e1fa", message: "Digest archive: edition numbers come from the full non-blocked history, not the 365-row window" },
    { hash: "7a22770e", message: "Same-unit test merges (part 2): V9 ruling suites fold into their owners, Telegram alert parser tests split out" },
    { hash: "389bf2a5", message: "Same-unit test merges (part 1): yield coverage fixtures, one commodity-freshness suite, real supply contract in snapshot-supply" },
    { hash: "44e8fb1e", message: "Telegram harness: strict D1 writes by default" },
    { hash: "1b2bb30c", message: "src/functions test lanes (part 3): mint-authority view-model suite split out, V9 presentation fixtures shared, functions proxies share one upstream mock" },
    { hash: "f60567a8", message: "Reserve/redemption test lanes: one assurance fence, generated corpus exemptions, satellite suites merged, SQL pins become SQLite outcomes" },
    { hash: "27ab7ab4", message: "src test lanes (part 2): seven suites table-driven, one API fetch-stub helper, type escapes replaced by field-checked fixtures" },
    { hash: "9ca2dd84", message: "Cron harness (part 2): yield alias layer deleted, one mint-burn harness, semantic Chainlink feeds, strict yield fixtures" },
    { hash: "d9610068", message: "Telegram test lanes (part 2): suites merged by concern, adapter-wiring tests deleted, table literals and route context centralised" },
    { hash: "01c7954e", message: "Price/depeg test lanes: enrich-price suites re-homed by concern, authoritative sources split into four suites, PSI ladders on real SQLite" },
    { hash: "ae629d14", message: "src/scripts/functions test lanes (part 1): section-keyed detail-page mocks, plumbing-only hook suites deleted, scaffolding table-driven" },
    { hash: "58501c5f", message: "Cron harness (part 1): one table-driven slot-registry suite replaces nine wiring suites; scheduled mocks collapse onto one factory" },
    { hash: "a8f2975b", message: "Telegram test lanes (part 1): snapshot artifact deleted, upsert-SQL pin merged, drain/pending pins become row assertions, webhook callbacks merged by concern" },
    { hash: "1bd7fcbd", message: "Implementation pins become outcome assertions; the 434-line census replay reimplementation is deleted" },
    { hash: "9156189e", message: "DEX/discovery/measured-execution test lanes: merged twins, extracted LKG/history builders, deleted projection tautologies; two test-only exports removed" },
    { hash: "d5e6534f", message: "shared/lib test lane: registry invariants replace transcriptions; V9 scoring fixtures centralised; duplicate queue coverage removed" },
  ],
};
