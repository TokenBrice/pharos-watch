import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-05-18", to: "2026-05-24" },
  headline:
    "Design-system overhaul lands, the MiCA tracker goes live, and the yield page gets a ground-up rebuild.",
  fieldNotes:
    "The busiest week in a while, and most of it is about how Pharos reads. A foundational design-system pass reset the tokens, contrast, and motion under every surface; the yield page was torn down and rebuilt around a draggable risk budget; and two new front doors opened — a MiCA compliance tracker and a Learn hub that connects case studies to the charts. Coverage crossed 399 coins, and a late-week push hardened redemption backstops and added a Mint Authority view.",
  summary: [
    {
      label: "Design system & UX overhaul",
      tag: "design",
      description:
        "Foundational tokens consolidated with a severity AA-contrast fork, then an IA graph, a11y and motion choreography, editorial voice, inline sparklines with linked brushing, and a universal watchlist with palette verbs.",
    },
    {
      label: "Yield intelligence overhaul",
      tag: "feature",
      href: "/methodology/yield-changelog/",
      description:
        "Yield rebuilt around a scatter and a draggable risk-budget slider, a source sheet showing confidence and depth, a per-factor PYS breakdown, per-coin APY-change attribution, and a public decision ledger (v8.16).",
    },
    {
      label: "MiCA tracker launch",
      tag: "coverage",
      description:
        "A new /mica/ tracker launches and sweeps to full coverage at 25 coins, cross-referenced against the ESMA register, with GUSD ruled non-compliant and the tracker cross-linked from coin and compliance surfaces.",
    },
    {
      label: "Learn hub & depeg case studies",
      tag: "feature",
      description:
        "A new /learn hub and LEARN nav group launch with a depeg case-studies section; case studies cross-link from coin, cemetery, depeg, and mechanism pages, and chart annotations now link to the case study behind each event.",
    },
    {
      label: "Guided stablecoin Picker",
      tag: "feature",
      description:
        "A guided stablecoin picker ships at /screener/picker/ on a new selector engine: snapshot endpoint, peg-scope scoring, custody and depeg-watch logic, a mobile form, a homepage callout, and a Telegram follow command.",
    },
    {
      label: "Navigation & homepage refresh",
      tag: "design",
      description:
        "An alternate homepage and timeline layout land, with a 9-depeg desktop grid, an optional phosphor CRT reading mode, a unified chain-profile hero, expanded mechanism explainers, and a prominence-ranked command palette.",
    },
    {
      label: "Pricing integrity & reliability",
      tag: "infra",
      href: "/methodology/pricing-pipeline-changelog/",
      description:
        "DEX price sanity gates and Carbon normalization make DexScreener augmentation opt-in (pricing v6.05), Liquidity Score v5.7 adds price-gating, plus a cron staleness watchdog and an API-key rate-limit fallback.",
    },
    {
      label: "Redemption backstop coverage",
      tag: "coverage",
      href: "/methodology/#safety-scores-methodology",
      description:
        "Redemption backstop scoring (v4.04) gains documented route sources, source-support validation, and expanded confidence scoring, with a coverage matrix that surfaces outage and degraded states; report cards degrade on redemption outages, the data is exposed in stablecoin JSON-LD, and malformed telemetry fails closed.",
    },
    {
      label: "Mint Authority transparency",
      tag: "feature",
      description:
        "A new Mint Authority section on coin pages surfaces who can mint and control supply — control addresses with on-chain evidence, Safe-module display, and risk-tone posture cues — with coverage expanded across the top stablecoins.",
    },
    {
      label: "Broader coverage",
      tag: "coverage",
      description:
        "The tracked universe reaches 399 coins with FUSD, sDOLA, GLDT, and Ondo's iAUON and sLVON added and pre-launch gynUSD joining, while reserve adapters climb to 57 and live-reserve coverage to 267.",
    },
  ],
  stats: { totalCommits: 448 },
  commits: [
    { hash: "eada0aad", message: "Sync report card snapshot test generation" },
    { hash: "08f9e5dc", message: "Stabilize coverage page section tests" },
    { hash: "ca66632b", message: "Sync validate prebuild parity test" },
    { hash: "2e91831b", message: "Refresh build attribution baseline" },
    { hash: "4a60bb25", message: "Adjust client registry chunk budget" },
    { hash: "9e2239b7", message: "Prune unused release exports" },
    { hash: "470eac5f", message: "Update stablecoin detail hotspot baseline" },
    { hash: "2e0ee1e1", message: "Remove unused stablecoin detail test binding" },
    { hash: "d51dbebf", message: "Clarify dependency coverage audit docs" },
    { hash: "04c480f4", message: "Fix dependency coverage script doc path" },
    { hash: "3c39f7a5", message: "Add risk-tone cues and flatten Mint Authority controls" },
    { hash: "9d5a80a6", message: "Clarify mint authority Safe module display" },
    { hash: "fec47fc5", message: "Fix redemption wrap-up validation findings" },
    { hash: "56da0ca7", message: "Document base issuer route sources" },
    { hash: "97a95a42", message: "Document collateral and issuer route sources" },
    { hash: "ebf1d4a5", message: "Remove unused redemption route-status feed hook" },
    { hash: "131afbf4", message: "Centralize redemption display labels" },
    { hash: "f3efdaeb", message: "Expand top stablecoin mint authority coverage" },
    { hash: "c4f34ff2", message: "Document stablecoin redemption route sources" },
    { hash: "fec39124", message: "Document commodity redemption route sources" },
  ],
};
