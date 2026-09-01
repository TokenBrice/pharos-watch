import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-05-11", to: "2026-05-17" },
  headline:
    "Screener launches, detail pages rebuild around verdict, and Yield v8.13 ships multi-currency benchmarks.",
  fieldNotes:
    "Three releases that change how Pharos reads. The Screener gives the research-grade audience its own room, with the URL as the language of saved work. The detail rebuild stops asking visitors to assemble the answer themselves: the verdict comes first now, the mechanism schematic next, and the chart annotations carry the receipts. Yield v8.13 finally treats GBP, JPY and the others as first-class: non-dollar benchmarks, on their own tab. The trust surfaces (PDFs, RSS, citations) ship alongside.",
  summary: [
    {
      label: "Pharos Screener launch",
      tag: "feature",
      description:
        "New /screener/ tool ships with composable filters, blacklistable + safety-tier predicates, URL state codec, and universal CSV/NDJSON/Markdown export for power users.",
    },
    {
      label: "Detail page rebuild",
      tag: "design",
      description:
        "Detail pages restructure around section banners, with a verdict-first hero, mechanism schematics, AI summaries with Term popovers, attestor + freezability identity pills, and a mobile compact summary bar.",
    },
    {
      label: "Trust & SEO surface area",
      tag: "feature",
      description:
        "Ten methodology white-paper PDFs go live, RSS feeds ship for digest/depeg/methodology/cemetery, citation blocks + Pharos URN substrate land, plus AI-disclosure badges and a page-footer trust strip.",
    },
    {
      label: "Yield methodology v8.13",
      tag: "feature",
      description:
        "Yield gets a v8.13 bump with a multi-currency benchmark registry (GBP/JPY/MXN/BRL/AUD/CAD), currency tab strip, per-coin /stablecoin/[id]/yield page, source-risk scoring, and yield-spike annotations.",
      href: "/methodology/yield-changelog/",
    },
    {
      label: "Tape → Timeline migration",
      tag: "feature",
      description:
        "The Tape moves to /timeline/ with per-class digest grouping and new PSI/DEWS/mint-burn/yield/peak-worsen/methodology/cemetery/lifecycle projectors. Copy-permalink, server-side search, and wire-service redesign land.",
    },
    {
      label: "Telegram Mini App maturation",
      tag: "feature",
      description:
        "Mini App Phase 2-4 ships with HMAC hardening, /forget command, batched coin-setting writes, global depeg-step setting, and watchlists. Group UX, retention, and webhook delivery hardened across the board.",
    },
    {
      label: "DEWS v6 + depeg lifecycle",
      tag: "feature",
      description:
        "DEWS v6 lands with evidence + freshness scoring, depeg lifecycle provenance schema, /depeg/<event>/ pages gated at 250 bps threshold, incident triage surface, and historical provenance persistence.",
      href: "/methodology/depeg-changelog/",
    },
    {
      label: "Reserve coverage expansion",
      tag: "coverage",
      description:
        "Reserve adapter count climbs to 55 with sGHO, Zephyr, centrifuge-vault, Resupply, hbUSDT, and score-grade adapters. Live-reserves coverage reaches 252; methodology v7.23 documents the scoring policy.",
      href: "/methodology/",
    },
    {
      label: "Redemption backstop v4",
      tag: "feature",
      description:
        "Redemption backstop v4 ships with audited route coverage, capacity-model split, run-row handling, source-reviewed backstop scoring, refreshed coverage modeling, and a redemption backstop card on detail pages.",
      href: "/methodology/",
    },
    {
      label: "Performance + bundle work",
      tag: "infra",
      description:
        "Client registry splits into a slim 281 KiB path (down from 1.37 MiB), fonts move to woff2 + subset Newsreader, detail charts lazy-mount on intersection, Web Vitals stream to GA, and chunk-size budgets gate merges.",
    },
    {
      label: "Worker + scripts modularization",
      tag: "infra",
      description:
        "Scripts split into ci/maintenance/oneshots, telegram webhook + store split into focused submodules, shared/lib groups by domain (chains, classification, telegram, blacklist), and cron mock factories standardize tests.",
    },
    {
      label: "CI + supply chain hardening",
      tag: "security",
      description:
        "Zizmor + CodeQL findings remediated, persist-credentials + explicit secrets enforced on workflows, deploy validation runtime trimmed, validate leaf jobs start immediately, and pages release smoke gates clarified.",
    },
  ],
  stats: { totalCommits: 945 },
  commits: [
  { hash: "498da50a", message: "Refresh docs metadata" },
  { hash: "a5b4cffe", message: "Expand reserve and redemption coverage" },
  { hash: "a4297211", message: "Fix coverage matrix stablecoin column overflow" },
  { hash: "52cce346", message: "Fix reserve adapter request header tests" },
  { hash: "d86229f8", message: "Fix reserve sync CI validation" },
  { hash: "de9fd912", message: "Improve reserve sync coverage rescues" },
  { hash: "1bc7275b", message: "expand redemption backstop coverage" },
  { hash: "84fc4bac", message: "feat(telegram): add non-USD preset watchlists" },
  { hash: "924a87a0", message: "chore(generated): refresh screener sitemap date" },
  { hash: "59c461b4", message: "polish(screener): streamline page layout" },
  { hash: "a525fcb7", message: "feat(screener): refine filter controls" },
  { hash: "c6aa0960", message: "chore(generated): refresh public metadata dates" },
  { hash: "e21e56eb", message: "refactor(reserves): break live reserve store cycle" },
  { hash: "491d1302", message: "refactor(ui): split relative time helper" },
  { hash: "41ee2648", message: "chore(guardrails): refresh hotspot and unused-export metadata" },
  { hash: "7843689f", message: "fix(scripts): align maintenance validation docs" },
  { hash: "1c680f24", message: "fix(telegram): share bot registration payloads" },
  { hash: "350e58b5", message: "fix: repair USG inception supply history" },
  { hash: "645c5f23", message: "fix(screener): show stablecoin logos" },
  { hash: "c7720591", message: "fix(docs): repair 24 broken source-path references after swarm file moves" },
  ],
};
