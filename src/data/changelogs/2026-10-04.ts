import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-09-28", to: "2026-10-04" },
  headline:
    "Safety Score V10 ships through five versions in three days while the registry grows from 409 to 488 coins.",
  fieldNotes:
    "Most of the week went into evidence. An October 1 curation pass across 331 coins fed V10, then two research waves worked open Safety Score facts from primary sources. Ratings followed what verifiers could prove: DAI and USDS fell when 129 live Vat wards lacked complete execution certificates, and ZCHF dropped from A- to D until ruling D30 on its minority-veto process restored it. Coverage grew alongside, with 66 active and 11 pre-launch additions.",
  summary: [
    {
      label: "Safety Score V10",
      tag: "feature",
      description:
        "V10 adds physical-to-USD Exit and known-supply sizing after 9.93 to 9.98; 10.01 stops scoring Pharos-side pipeline gaps as asset risk, re-rating 138 cards and cutting Not Rated from 23 to 17.",
      href: "/methodology/scoring-changelog/",
    },
    {
      label: "Issuance governance rulings",
      tag: "feature",
      description:
        "10.02 separates governed issuance from economic bounds: crvUSD rises to B-, DAI and USDS fall to C- and D. 10.03's minority-veto rung returns ZCHF from D to A-; 10.04 clears 599 unresearched-fact artifacts.",
      href: "/methodology/scoring-changelog/",
    },
    {
      label: "Unknown-resolver research",
      tag: "coverage",
      description:
        "An October 1 pass re-verified 331 active coins against primary evidence; two research waves in 152 commits then worked open Safety Score facts and fed published redemption fees into Exit route configs.",
    },
    {
      label: "Coverage expansion",
      tag: "coverage",
      description:
        "The registry grows from 409 to 488 entries, led by 66 active and 11 pre-launch additions. Open USD and Theo thUSD go active, SoFiUSD returns, and JLTXX waits in quarantine for its first reserve snapshot.",
    },
    {
      label: "Dependency map Exposure mode",
      tag: "feature",
      description:
        "Exposure mode shows which coins rest on an upstream asset and how much of their backing, with look-through shares, modeled score scenarios from an offline lane (ADR-36) and a 35 KB gzip graph API.",
    },
    {
      label: "Cemetery plot map",
      tag: "design",
      description:
        "/cemetery/ becomes an isometric plot map grouped by cause of death, linked to an autopsy register and charts; the register's server HTML falls from 772 KB to 237 KB.",
    },
    {
      label: "Honest public values",
      tag: "feature",
      description:
        "Release B makes flows, pricing, PSI and Chain Health publish null when unobserved, Liquidity 6.9 counts only DEX volume observed within 72h, and detail heroes stop printing absent market cap as $0.00.",
      href: "/methodology/",
    },
    {
      label: "Supporter and partner keys",
      tag: "security",
      description:
        "/api/ now leads with a $10 donor supporter key and a partner key. The self-serve key lane is deleted, and supporter eligibility counts only reviewed token contracts, now 15 coins, up from 5.",
    },
    {
      label: "Publication resilience",
      tag: "infra",
      description:
        "A card that breaks its public contract is quarantined (R8) instead of failing the Safety Score run, reclaimed graphs restore 128 MiB headroom, and digests move to Opus 5.5 at high effort.",
    },
  ],
  stats: { totalCommits: 349 },
  commits: [
    { hash: "825528f1", message: "funding(ledger): record two October USDC donations and backfill Base DonationHandler payouts" },
    { hash: "229bbc6f", message: "Record observed activation time for Safety Score v10.03 and v10.04" },
    { hash: "6fe23cbd", message: "Keep public control execution paths component-local" },
    { hash: "adbded5f", message: "Fix release-gate tests broken by wave data edits" },
    { hash: "0a9f528e", message: "Set Safety Score v10.03 and v10.04 activation time" },
    { hash: "40ce04a0", message: "Safety Score v10.03: minority-veto issuance rung (owner ruling D30)" },
    { hash: "7b878a77", message: "Keep quarantined upstreams from cascading into dependent cards" },
    { hash: "b865bd3c", message: "Fix the B-on-reserve-factor publication crash and quarantine bad cards (R8)" },
    { hash: "29e11a21", message: "Renumber the unresearched-fact cleanup release from v10.03 to v10.04" },
    { hash: "0b43abb7", message: "Link Frax's reUSD reserve row to Resupply reUSD" },
    { hash: "57fa65fd", message: "Route operational-resilience and wrapper-local gaps in the missing-data registry" },
    { hash: "db78db23", message: "Mirror Workers' jitless zod in the V9 resource probe" },
    { hash: "7636e18a", message: "Release V9 publication graphs earlier to restore 128 MiB headroom" },
    { hash: "8b9b2c48", message: "Safety Score v10.03: admitted maturity-applicability bounds close the maturity gap" },
    { hash: "fc578451", message: "Integrate wave-2 redemption fee terms into route configs" },
    { hash: "14ab0bfb", message: "Apply wave-2 verifier corrections" },
    { hash: "c942813d", message: "Apply late verifier corrections and drop re-added variant identity keys" },
    { hash: "2b63c934", message: "Integrate researched redemption fee and settlement terms into route configs" },
    { hash: "21f479aa", message: "Research Safety Score unknowns for senpathusd-sentora, senpyusdmain-sentora, usdm-monetrix" },
    { hash: "d590af61", message: "Research Safety Score unknowns for senrlusdv2-sentora, senpyusdprimev2-sentora, sbc-brale, usdz-anzen" },
  ],
};
