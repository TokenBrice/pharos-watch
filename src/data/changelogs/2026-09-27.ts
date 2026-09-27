import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-09-21", to: "2026-09-27" },
  headline:
    "Holistic review makes unavailable data fail closed, a false VCHF depeg brings majority pool rules, and yield hits 8.45.",
  fieldNotes:
    "A week of the same repair at two scales. The 2026-09-21 holistic review found optimism everywhere, an absent reading published as zero and a failed read as healthy, and wrote the cure down as ADR-28 to ADR-35. The days after tested it: dormant pools held VCHF off its peg, a Pendle market posed as sUSN's native yield, and seven reserve adapters drifted. Each fix names the evidence that must agree before a number moves.",
  summary: [
    {
      label: "Fail-closed data contracts",
      tag: "security",
      description:
        "Review waves replaced optimistic defaults across supply, DEWS, yield, freeze, blacklist and route-status producers: an unavailable observation publishes null and a reason, never zero, healthy or open.",
    },
    {
      label: "Safety Score 9.92",
      tag: "feature",
      description:
        "Six versions since 9.5: chain maturity needs dated citations, assurance expires 100 days after period end, and Noon's USN/sUSN corrections were verified on-chain first. USDT settles at 74/B.",
      href: "/methodology/scoring-changelog/",
    },
    {
      label: "Pricing 6.24 to 6.36",
      tag: "feature",
      description:
        "Thirteen versions: lane-scoped DEX corroboration, guarded recovery routes for BD, AUDm, legacy USDv and USDaf, coherence-guarded pool admission, fail-closed DEX publication and Solayer sUSD NAV pricing.",
      href: "/methodology/pricing-pipeline-changelog/",
    },
    {
      label: "DEWS 6.23 to 6.27",
      tag: "feature",
      description:
        "Absent evidence no longer scores as calm, and after two dormant pools held a false VCHF depeg open, pool challengers need a protocol-group majority to confirm a depeg or veto recovery.",
      href: "/methodology/depeg-changelog/",
    },
    {
      label: "Yield 8.44 and 8.45",
      tag: "feature",
      description:
        "Pendle PT markets stop posing as native wrapper yield; sources must now prove asset identity and holder return, missing score evidence withholds PYS, and detail cards show where yield comes from.",
      href: "/methodology/yield-changelog/",
    },
    {
      label: "Liquidity, backstop and PSI",
      tag: "feature",
      description:
        "Liquidity 6.8 adds pair-price coherence at pool admission, backstop 4.44 requires same-run route evidence for a live status, and PSI 3.62 replays supply as-of the day.",
      href: "/methodology/",
    },
    {
      label: "Reserve and conservation audits",
      tag: "coverage",
      description:
        "Seven drifted adapters realigned, DOC and USD3 re-pinned after upgrades, August KPMG reports admitted for Paxos products, and mint/burn conservation gains four waves plus laws for USDT, OUSD and USDO.",
    },
    {
      label: "Cron and delivery reliability",
      tag: "infra",
      description:
        "Retention and reads are bounded, degraded runs name a reason, one D1 overload no longer cascades into red crons, DEX bodies are capped after a 172 MB kill, and Telegram delivery gains fencing.",
    },
    {
      label: "Dwellir RPC trial",
      tag: "infra",
      description:
        "Dwellir sponsors a year of RPC access as a metered last-position operator across 29 EVM endpoints, watched by an hourly parity monitor against incumbent operators; Arc joins the chain registry.",
    },
    {
      label: "Three coins frozen",
      tag: "coverage",
      description:
        "AZND and XTUSD freeze after a wind-down and a stale official market, cdxUSD after its peg broke to $0.2457; AZND's $16.3M was a token count, so the aggregate drop is an honest cliff.",
    },
    {
      label: "Deduplication and test lanes",
      tag: "coverage",
      description:
        "Shared contracts got single owners and oversized V9, Telegram and yield modules split leafward, cutting duplicated lines from 7,568 to 3,073; nine test lanes replaced pins with outcomes.",
    },
    {
      label: "Registry and funding ledger",
      tag: "coverage",
      description:
        "Twenty pre-launch coins refreshed and two bank-led programmes tracked, taking the registry to 409; msUSD's September depeg low is annotated and two USDC receipts reconciled into the funding ledger.",
    },
  ],
  stats: { totalCommits: 411 },
  commits: [
    { hash: "0f036df7", message: "Document yield v8.45 hardening, run quality and rollout phases" },
    { hash: "1348dbec", message: "Show where yield comes from on the stablecoin detail card" },
    { hash: "2c4cd040", message: "Serve yield freshness honestly behind a wire-compatible rollout" },
    { hash: "ac727945", message: "Isolate yield publication failures and report run quality per R4" },
    { hash: "b653a695", message: "Fail closed on yield identity, derived rates and incomplete score evidence (yield v8.45)" },
    { hash: "b861ae54", message: "data(pre-launch): weekly refresh across 20 coins; track two bank-led programmes" },
    { hash: "ed5bd5c8", message: "data(annotations): pin msUSD September depeg low from annotation sweep" },
    { hash: "124e023a", message: "funding(ledger): record Base founder USDC and Ethereum USDC donation" },
    { hash: "63f93815", message: "Keep the cron-derived cause code list module-private" },
    { hash: "0f2d1585", message: "Drop the solomon-protocol adapter mapping review now that the lane is parked" },
    { hash: "d9445050", message: "Record pricing methodology v6.34-v6.36 for tonight's price-lane repairs" },
    { hash: "4ba7920f", message: "Restore missing and low-confidence price lanes" },
    { hash: "e83b6b34", message: "Repoint Base Uniswap v3/v4 subgraphs that silently stopped answering" },
    { hash: "7027d53f", message: "Serve liquidity health and degraded-cron causes from live cron runs" },
    { hash: "53d46857", message: "Stop legacy USDv double counting and quiet two reserve error loops" },
    { hash: "16aecc90", message: "Re-pin DOC and USD3 reserve reads after same-night contract upgrades" },
    { hash: "29227592", message: "Repair seven reserve adapters that drifted from their upstreams" },
    { hash: "05023b95", message: "Admit August assurance reports for Paxos products and AUDX" },
    { hash: "13dc8736", message: "Keep crvUSD's score-grade reserves when on-chain reads time out" },
    { hash: "044ee9be", message: "test(yield): cover on-chain failover through the pinned pool, not Layer 3" },
  ],
};
