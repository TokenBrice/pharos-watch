import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-05-25", to: "2026-05-31" },
  headline:
    "The Depeg Resolver (DDR/DDRR) v2 ships at /depeg, dashboard cards flatten, and the data layer gets a two-pass audit.",
  fieldNotes:
    "After last week's design-system sprint, the new tone moves into product. The Depeg Resolver opens to the public: DDR predicts how long a current depeg will last, DDRR scores how well past predictions held up, and the rest of the dashboard quietly harmonizes around the flat-card baseline. Two data-enhancement passes also work through a backlog of reserve, redemption, and classification follow-ups.",
  summary: [
    {
      label: "Depeg Resolver (DDR/DDRR) v2",
      tag: "feature",
      href: "/methodology/depeg-resolver-changelog/",
      description:
        "/depeg goes public: DDR predicts how long an active depeg will last with sticky locked forecasts and a verdict-band lockup; DDRR scores past predictions on a reviewer. DDR also shows on each coin page.",
    },
    {
      label: "Data audit & remediation",
      tag: "coverage",
      description:
        "Data passes plus follow-ups recover crvUSD and Reservoir reserve breakers, move ZCHF capacity to CHFAU, switch fxSAVE redemption to live capacity, align USG/HLUSD/JPYC/YUSD, and pin StablR's EURR/USDR multisig exploit.",
    },
    {
      label: "Compliance & GENIUS tracker",
      tag: "feature",
      href: "/methodology/",
      description:
        "A new GENIUS Act tracker surface launches alongside expanded compliance metadata research, and the MiCA tracker now enforces out-of-scope constraints to keep deliberately-undefined coins distinct from unassessed ones.",
    },
    {
      label: "Pre-launch additions",
      tag: "coverage",
      description:
        "Tenbin Gold (tGLD), a synthetic gold debt-note from a CME-futures basket, and GEL₮, Tether's pre-launch Georgian Lari, join the pre-launch list, and the weekly upcoming sweep tracks Flipcash's launch and USDPT.",
    },
    {
      label: "Flat-card design pass",
      tag: "design",
      description:
        "Card accents flatten: the colored border-l retires except for data-driven indicators. Price Transparency and Redemption Backstop go full-width on coin pages, and depeg page hierarchy tightens around the resolver.",
    },
    {
      label: "Platform hygiene",
      tag: "infra",
      description:
        "Cron cache helpers centralize, depeg resolver and DEWS D1 retries harden, admin API contracts get schema validation, and several large surfaces (yield, command palette, timeline, picker) split into smaller modules.",
    },
  ],
  stats: { totalCommits: 141 },
  commits: [
    { hash: "6eecb559", message: "chore(generated): refresh client registry" },
    { hash: "0f62f475", message: "chore(generated): refresh prevalidated registry" },
    { hash: "94059597", message: "chore(generated): refresh cemetery dataset" },
    { hash: "9013a9e1", message: "chore(generated): refresh sitemap dates" },
    { hash: "c2b058a1", message: "data(pre-launch): weekly update — Flipcash launch, USDPT tracking, dead-link fixes" },
    { hash: "2c99a74c", message: "feat(annotations): pin StablR EURR/USDR multisig exploit (2026-05-24)" },
    { hash: "ab794b65", message: "fix(ddrr): bound operational miss rate" },
    { hash: "404eb147", message: "test(telegram): cover my-chat-member failure path" },
    { hash: "b5229594", message: "test(api): use valid admin polling fixtures" },
    { hash: "d231ce5e", message: "fix(api): import schemas from concrete shared modules" },
    { hash: "580bd444", message: "chore(generated): refresh docs metadata" },
    { hash: "0ccce994", message: "ci: ratchet critical coverage and cron console usage" },
    { hash: "71aab01d", message: "fix(worker): harden dex merge and ddr storage writes" },
    { hash: "4e5fb755", message: "fix(api-key): stop parsing query credentials" },
    { hash: "1c17cbff", message: "fix(api): validate admin query contracts" },
    { hash: "6f2998b5", message: "docs: sync audit findings with source" },
    { hash: "155de905", message: "style(timeline): trim helper eof blanks" },
    { hash: "ec77c876", message: "docs: document remediation guardrails" },
    { hash: "0f98e819", message: "refactor(yield): extract leaderboard row parts" },
    { hash: "d3763f96", message: "refactor(ddr): split resolver row card" },
  ],
};
