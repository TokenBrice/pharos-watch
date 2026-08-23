import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-08-17", to: "2026-08-23" },
  headline:
    "The Safety Score map ships daily, Liquidity Score v6 lands, and the yield surface stops blanking.",
  fieldNotes:
    "A week of turning fragile things into scheduled ones. The Safety Score landscape stopped being a manual monthly artifact and became a guarded daily publication that rides along with the social digest. Liquidity Score v6 completed its staged cutover, correcting a Raydium double count that had been quietly inflating depth. Most of the remaining effort went where it usually goes after a busy month: cron lanes, memory ceilings, and the duplication that accumulates when everything ships at once.",
  summary: [
    {
      label: "Daily Safety Score map",
      tag: "feature",
      description:
        "The shareable Safety Score landscape became a daily 07:20 UTC publication, generated behind fail-closed guards for stale data, join coverage, font loading, and layout collisions, and it rides the social digest.",
    },
    {
      label: "Safety Score V9 stability",
      tag: "feature",
      description:
        "V9 advanced from v9.23 to v9.33: the mint-authority and bridge-risk boundary closed its fail-open, Solana attribution anchors hardened, reserve-weight boundary drift was canonicalized, and curation entries now expire.",
      href: "/methodology/scoring-changelog",
    },
    {
      label: "Liquidity Score v6",
      tag: "feature",
      description:
        "The v6.0 cutover corrected a Raydium double count that scored concentrated pools as plain AMMs, retired the native lane, and deleted the shadow inventory. v6.1 scopes native confirmation to covered pool families.",
      href: "/methodology/liquidity-score-changelog",
    },
    {
      label: "Yield availability",
      tag: "feature",
      description:
        "Yield rankings now fall back to the coherent publish-time safety snapshot instead of blanking scores after every scoring deploy, with an explicit stale label and a 24-hour window. Base Dollar yield joined at v8.41.",
      href: "/methodology/yield-changelog",
    },
    {
      label: "Scheduler reliability",
      tag: "infra",
      description:
        "Reserve interruption recovery left shadow mode, transient D1 transport loss became retriable, CPU-heavy quarter-hour lanes moved to the hourly class, and DDR now runs before V9 attribution to keep both inside the heap.",
    },
    {
      label: "Broader coverage",
      tag: "coverage",
      description:
        "Base Dollar was promoted to active with a verified Base deployment, Aerodrome price discovery, and a documented mint-authorization path. Reflexer's RAI Dollar joined as pre-launch, taking the tracked catalog to 405.",
    },
    {
      label: "Repository health",
      tag: "infra",
      description:
        "A simplification wave drained 15k lines of duplication, a repository review closed four P0 correctness defects and hardened the Worker, and structured data stopped advertising a credentialed endpoint as a public download.",
    },
  ],
  stats: { totalCommits: 45 },
  commits: [
    { hash: "b394abd7", message: "Code simplification wave: -15k LOC of duplication, plus the SEO batch (#930)" },
    { hash: "8acea310", message: "fix(snapshot-supply): restored-only ids no longer veto the daily snapshot (#928)" },
    { hash: "a4fb5cdb", message: "fix(watchdog): exclude producers beyond cron_runs retention from freshness lanes (#927)" },
    { hash: "670ed6d5", message: "Repository review implementation: P0 correctness, data fail-closed, worker hardening, consolidation (#926)" },
    { hash: "34200751", message: "Bound V9 publication compiler memory (#925)" },
    { hash: "8ef00a63", message: "fix(digest): stop unverified DEX liquidity artifacts from leading the digest (#924)" },
    { hash: "6bd2501c", message: "fix(v9): canonicalize reserve-weight boundary drift (#923)" },
    { hash: "b7a71e7a", message: "feat(digest): attach daily safety map to social posts" },
    { hash: "8786e3a5", message: "fix(cron): move CPU-heavy quarter-hour lanes to the hourly Cron CPU class (#921)" },
    { hash: "c8a21c96", message: "fix(v9): harden Solana attribution anchors" },
    { hash: "e8e4ff04", message: "fix(cron): stabilize distressed production lanes (#919)" },
    { hash: "07290bed", message: "fix(pricing): preserve fallback cursor fairness" },
    { hash: "93bb715c", message: "test(ci): restore Nightly type validation" },
    { hash: "cbd39e57", message: "fix(cron): harden distressed production lanes" },
    { hash: "74ca9d2b", message: "fix(worker): capture V9 attribution before DDR heap work (#918)" },
    { hash: "393984d0", message: "fix(ops): enroll exit-route watchdog in night watch (#917)" },
    { hash: "3f481cd5", message: "fix: restore production scheduler health and stabilize Safety Score V9 (#916)" },
    { hash: "26b56753", message: "Add Base Dollar yield and compliance coverage (#915)" },
    { hash: "fdd568e8", message: "fix(cron): run DDR before V9 attribution (#914)" },
    { hash: "c432e514", message: "ci(safety-map): enable the daily 07:20 UTC schedule (#913)" },
  ],
};
