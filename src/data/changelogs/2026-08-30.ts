import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-08-24", to: "2026-08-30" },
  headline:
    "Safety Score V9 reaches 9.45, the orbital Safety Map ships, and four new swap census providers close chain gaps.",
  fieldNotes:
    "Two threads ran side by side. Scoring kept correcting itself where evidence and measurement had been conflated. A stale attestation is not an absent one, and an unproven settlement bound is not a measured zero. Meanwhile production spent the week healing: retired price feeds, latched circuit breakers, four broken reserve lanes, and a NAV gap that quietly degraded every dependent cron. The map became the front door.",
  summary: [
    {
      label: "Exit-capacity truth",
      tag: "feature",
      description:
        "Safety Score v9.44 and v9.45 separated a measured zero from an unproven settlement bound: an open queue with no proven completion bound now floors Exit under the unverified ceiling instead of grading F.",
      href: "/methodology/scoring-changelog",
    },
    {
      label: "Reserve evidence gates",
      tag: "feature",
      description:
        "V9 9.4 through 9.43 split reserve classification from composition freshness, let an audited composition survive a stale feed on its own rung, and bounded Tether's feed by its actual disclosure cadence.",
      href: "/methodology/scoring-changelog",
    },
    {
      label: "Redemption backstop v4.4",
      tag: "feature",
      description:
        "The standalone redemption route now publishes unestablished capacity and stays unrated when an open queue's settlement bound is unproven; paused routes keep their measured impairment.",
      href: "/methodology/redemption-backstop-changelog",
    },
    {
      label: "Orbital Safety Map",
      tag: "design",
      description:
        "The daily Safety Score map became a supply-ranked orbital galaxy poster with readable logo floors and integrated tier counts, promoted into the overview hero and rendered deterministically across tier changes.",
    },
    {
      label: "Swap census coverage",
      tag: "coverage",
      description:
        "Aquarius, Tezos/TzKT, ICON Balanced, and Kava Swap census providers joined DEX discovery, cutting provider-inaccessible deployments from 50 to 40, alongside a curation drive across reserve, mint, and bridge sidecars.",
    },
    {
      label: "Production recovery",
      tag: "infra",
      description:
        "Pricing moved 6.208 to 6.213: Pyth retired, the DexScreener breaker unlatched on partial success, VUSD and HCHF recovered, and delisted NAV vaults now price through their protocol-redeem route.",
      href: "/methodology/pricing-pipeline-changelog",
    },
    {
      label: "Leaner codebase",
      tag: "infra",
      description:
        "Three consolidation batches removed roughly 41.7k net lines of duplicated hooks, dead worker pipelines, and retired migrations, with digests and methodology outputs byte-identical throughout.",
    },
    {
      label: "Docs and gate parity",
      tag: "infra",
      description:
        "The methodology, route, infrastructure, and process docs were re-verified against runtime and corrected, while the local PR gate gained darwin Gitleaks binaries so secret scans stop failing only in CI.",
    },
  ],
  stats: { totalCommits: 55 },
  commits: [
    { hash: "76e8a59f", message: "fix(pricing): value delisted NAV vault supply through the protocol-redeem route (#981)" },
    { hash: "94740ae2", message: "Safety Score V9 open-data-point resolution: producer hardening, curation drive, four census providers (#980)" },
    { hash: "c613d5c1", message: "Third-pass simplification: worker pipelines, shared authorities, AP contract rollouts (#979)" },
    { hash: "a597db65", message: "Release pre-launch stablecoin refresh for Aug 29 (#977)" },
    { hash: "82288155", message: "fix(frontend): clear nightly navigation lint failures (#975)" },
    { hash: "9584d1b0", message: "Local PR-gate parity: close the lanes that only failed remotely (#972)" },
    { hash: "91c27026", message: "Code health: swarm-audited consolidation, dedup, and dead-code removal (net -41.7k lines) (#971)" },
    { hash: "0e301d1a", message: "ci(gitleaks): pin EUTBL Soroban fixture by fingerprint, drop shape carve-out (#970)" },
    { hash: "5489cf1d", message: "Overnight curation lanes and V9 feed reliability (2026-08-28) (#969)" },
    { hash: "4917483f", message: "fix(cron): align DDR freshness with producer cadence (#966)" },
    { hash: "b1d75bb3", message: "fix(reserves): fail closed on non-comparable reserve bases (#965)" },
    { hash: "fb9ea760", message: "fix(cron): align yield and V9 source coordination (#964)" },
    { hash: "daf4e7c6", message: "fix(prices): reserve cap slot for reviewed exact targets (#963)" },
    { hash: "8c9cd710", message: "fix(prices): recover VUSD and harden circuit and cron coordination (#962)" },
    { hash: "e7e19458", message: "fix(prices): recover HCHF from audited CoinGecko quote (#961)" },
    { hash: "75628569", message: "Production recovery: reserves, cron isolation, and Safety Map (#960)" },
    { hash: "cea93f07", message: "Reserve sync recovery: bIB01 circulation basis, adapter mappings, minting gauge seams (#959)" },
    { hash: "bd004837", message: "Production recovery: retire Pyth, heal dexscreener breaker latching, repair four reserve lanes, fix tape depeg projector (#957)" },
    { hash: "323089f7", message: "chore(d1): 2026-08-26 destructive window ledger + repair backlog index backfill (#955)" },
    { hash: "fc4c7a81", message: "Gated backend closures: blacklist legacy-identity, baseline parity, missing-schema fallbacks (#954)" },
  ],
};
