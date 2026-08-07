import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_AUTHORITY_V1: readonly MethodologyChangelogEntry[] = [
  {
    version: "1.3",
    title: "Retired: mint risk is graded once by Safety Score V9",
    date: "2026-08-08",
    effectiveAt: 1786147202,
    summary:
      "The standalone Mint Authority Score is retired. Its distinct signals are merged into the Safety Score V9 Economic Control pillar's mint component, which is now the only mint score Pharos publishes. This lane is closed and kept for history.",
    impact: [
      "Homepage, screener, coverage, and the stablecoin detail card read the published V9 mint component and its posture band; no surface recomputes a mint score in the browser",
      "Resolved-incident age decay, MPC/HSM key-custody attestation, the fine multisig quorum ladder, and Safe module evidence moved into the V9 policy asset under `semantic.control.mintMergedSignals`",
      "Route-family pricing was excluded by design: the V9 cap and claim semantics already price it, and pricing it twice would double-count",
      "`mintAuthority.authorityPosture` is a validated annotation that never scores; curated-versus-derived disagreements are reported by `npm run safety-score-v9:mint-posture-queue`",
      "Curated `mintAuthority` review data, control rows, custody labels, and incident callouts are unchanged — they describe the review and now feed only the V9 fact set",
      "Further changes to mint risk are published in the Safety Score changelog, starting at 9.1",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.2",
    title: "Immutable-cap bonus requires explicit immutability",
    date: "2026-06-18",
    effectiveAt: 1781740800,
    summary:
      "The bounds component now grants the immutable-cap bonus only when every cap-limited mint-capable control explicitly records `canRaiseCap: false`. Unknown or omitted cap mutability keeps the route capped but no longer earns the immutable-cap bonus.",
    impact: [
      "Cap-limited controls with `canRaiseCap: true`, `canRaiseCap: \"unknown\"`, or missing cap-mutability evidence score as capped but mutable/unknown in the bounds component",
      "The slim client registry now projects `canRaiseCap` in `mintAuthoritySummary.controls[]` so aggregate surfaces compute the same Mint Authority Score as full metadata",
      "Route, controller, posture, incident, unbounded, EOA, confidence, and Decentralization blend weights are unchanged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.1",
    title: "Time-based incident-cap decay",
    date: "2026-06-11",
    effectiveAt: 1781200800,
    summary:
      "The hard incident cap on unbounded-or-compromised profiles now decays with the age of the most recent recorded mint incident: under 2 years caps at 10, 2-4 years at 15, and 4+ years at 20, always below the no-incident unbounded cap of 25.",
    impact: [
      "Decay is purely time-based on the most recent `mintIncidents` date; unparseable or missing dates stay at the strictest tier (10)",
      "Recent exploits (USR 2026, reUSD 2025) keep the 10 cap; MIM's 2024 incident moves to 15 and DOLA's 2022 incident to 20",
      "The unbounded posture cap (25), EOA cap (40), and confidence caps are unchanged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "1.0",
    title: "Initial Mint Authority Score release",
    date: "2026-06-11",
    effectiveAt: 1781136000,
    summary:
      "Introduced the standalone Mint Authority Score for reviewed stablecoin mint routes, controller topology, quantitative bounds, posture caps, and incident caps.",
    impact: [
      "Scores reviewed mint-authority profiles from 0-100 without feeding Safety Score or report-card grades",
      "Uses weakest-link controller scoring so one weak mint-capable route can constrain the result",
      "Adds unbounded and exploited-route caps, with NR preserved for missing or unresolved reviews",
    ],
    commits: [],
    reconstructed: false,
  },
];
