import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-08-10", to: "2026-08-16" },
  headline:
    "MiCA and GENIUS backfilled across 322 coins, redemption reaches 327 routes, and the V9 stack is rebuilt.",
  fieldNotes:
    "Two campaigns dominated. Compliance stopped being a gap: MiCA and GENIUS research landed for 322 coins that carried none, and the regulation page was rebuilt so the seventy actionable rows are not buried under four hundred null ones. Underneath, a long refactor gave duplicated concepts single owners and closed the correctness bugs that drift had been hiding. The reserve and redemption work kept widening, quietly.",
  summary: [
    {
      label: "Compliance coverage",
      tag: "coverage",
      description:
        "MiCA and GENIUS research drained the gap queue across 322 active coins, leaving 356 compliance sidecars. Registers were checked before issuer claims, and the DeFi and wrapper long tail stays deliberately undefined.",
    },
    {
      label: "Regulation workbenches",
      tag: "design",
      description:
        "The compliance page splits into an overview plus MiCA and GENIUS workbenches on the same URL contract, so actionable rows surface instead of drowning in out-of-scope ones. Both regimes join the coverage matrix.",
    },
    {
      label: "Independent assurance",
      tag: "coverage",
      description:
        "A new framework compiles reviewed examiner reports into hash-pinned manifests the Worker verifies at runtime and fails closed on drift. AUDX, EUROP, XSGD, XUSD, USDGO, anzen-usdz and USDRIF bind it.",
    },
    {
      label: "Wider exit routes",
      tag: "feature",
      href: "/methodology/redemption-backstop-changelog/",
      description:
        "Redemption v4.36 and v4.37 lift configured coverage from 315 to 327 coins, adding JPYSC trust redemption, EURO3 vault exits, Indigo iUSD and nine more reviewed routes, plus live route-openness and fee telemetry.",
    },
    {
      label: "Mint posture reconciliation",
      tag: "feature",
      href: "/methodology/scoring-changelog/",
      description:
        "Economic cap semantics, reconciliation and supervision were reviewed on 295 mint-authority profiles and all 64 adverse-posture assets. 54 coins moved in both directions; eight gained scored reconciliation evidence.",
    },
    {
      label: "Safety Score hardening",
      tag: "feature",
      href: "/methodology/scoring-changelog/",
      description:
        "Releases 9.17 through 9.22 added screener peg filters, stopped publishing reviewed-but-unproven residuals as missing data, activated the Uniswap V4 measured lane, and bound score-bearing gates to the policy digest.",
    },
    {
      label: "One owner per concept",
      tag: "infra",
      description:
        "A repository-wide cleanup gave peg taxonomy, chain ids, supply, exit capacity, URLs and logging single owners, unwound the api/cron and src/app boundaries, and fixed the divergences that duplication had been hiding.",
    },
    {
      label: "Leaner D1 footprint",
      tag: "infra",
      href: "/methodology/liquidity-score-changelog/",
      description:
        "DDR snapshots became validated gzip blobs, producer telemetry slimmed, and DEX pipelines moved to hourly source work with two-hourly Liquidity Score publication, cutting recurring writes and sustained storage growth.",
    },
  ],
  stats: { totalCommits: 48 },
  commits: [
    { hash: "f4e3aaf2", message: "fix(seo): keep taxonomy sitemap dates valid (#874)" },
    { hash: "d15ce5e2", message: "fix(ci): bootstrap production deploy classification (#873)" },
    { hash: "1d4b4d4d", message: "release: publish the current V9 refactor stack (#872)" },
    { hash: "9e443844", message: "fix(safety): make reserve slice identity durable (#871)" },
    { hash: "220ea556", message: "data(mint-authority): resolve adverse-posture reconciliation (#870)" },
    { hash: "964b681b", message: "data(mint-authority): reconcile durable-supply control profiles (#869)" },
    { hash: "71b329ae", message: "Release compliance workbenches and robust DEX price challenges (#867)" },
    { hash: "07ffb4e3", message: "feat(compliance): backfill MiCA and GENIUS coverage (#864)" },
    {
      hash: "feb9cd5a",
      message:
        "fix(reserves): disambiguate assurance report-index discovery against real publisher pages",
    },
    {
      hash: "2d9d05e3",
      message: "fix(reserves): resolve anzen-usdz Worker RPC resolution and batching failure",
    },
    {
      hash: "d95d96f7",
      message: "test(worker): restore evm-rpc critical coverage and record a gitleaks false positive",
    },
    {
      hash: "300367dc",
      message: "style(reserves): satisfy the changed-files lint gate for the batch-3 adapters",
    },
    {
      hash: "ec2c2462",
      message: "fix(reserves): re-park openeden-usdo after the production egress probe failed",
    },
    {
      hash: "62c013ca",
      message:
        "feat(reserves): independent-assurance report framework and five more score-grade promotions",
    },
    {
      hash: "3b6a6de4",
      message: "feat(redemption): release v4.37 with EURO3, Indigo iUSD, and JPYSC routes",
    },
    {
      hash: "76360ab4",
      message:
        "feat(reserves): add xdai-bridge, hive-hbd-protocol, and usdai-hub adapters plus IAUon NAV config",
    },
    {
      hash: "fa256c0a",
      message: "feat(redemption): release v4.36 with nine reviewed routes and USDO telemetry restore",
    },
    {
      hash: "2615aa3b",
      message:
        "feat(reserves): expand score-grade live coverage with chronicle-nav, USDXL, mGLOBAL, and USDO re-enable",
    },
    { hash: "6ae19e7a", message: "Fix score-grade reserve coverage reporting" },
    { hash: "27acb708", message: "Reduce Safety Score V9 unknowns and harden DEX publication (#857)" },
  ],
};
