import type { ChangelogEntry } from "./types";

export const entry: ChangelogEntry = {
  dateRange: { from: "2026-09-23", to: "2026-09-27" },
  headline:
    "A false VCHF depeg brings protocol-majority pool rules, and pricing moves through nine versions to 6.36.",
  fieldNotes:
    "The week's defects came from stale or dormant sources outvoting live ones: two idle pools held VCHF 6% over its peg, a Pendle market posed as sUSN's native yield, and seven reserve adapters drifted from their upstreams. Each fix names the evidence that must agree before a number moves. Noon's correction request went through the same filter, with every reserve and route claim checked on-chain before the sidecars changed.",
  summary: [
    {
      label: "Pool-challenger majority",
      tag: "feature",
      description:
        "Two dormant pools priced VCHF 6% above the ECB rate and held a false depeg open; pool challengers now need a protocol-group majority to replace consensus, confirm a depeg or veto recovery.",
      href: "/methodology/pricing-pipeline-changelog/",
    },
    {
      label: "Pricing 6.28 to 6.36",
      tag: "feature",
      description:
        "Nine versions: coherence-guarded pool admission, fail-closed DEX publication, cross-source price provenance, Curve quote sizing, Solayer sUSD NAV pricing and hard CEX tickers for MXNB and AUDD.",
      href: "/methodology/pricing-pipeline-changelog/",
    },
    {
      label: "Noon correction series",
      tag: "coverage",
      description:
        "Noon's correction request was verified on-chain and USN/sUSN evidence re-pinned under Safety Score 9.92, backstop 4.44, liquidity 6.7 and DEWS 6.25; a TRON re-review keeps USDT at 74/B.",
      href: "/methodology/scoring-changelog/",
    },
    {
      label: "Yield 8.44",
      tag: "feature",
      description:
        "Pendle PT markets no longer pose as native wrapper yield: the fallback layer excludes yield-tokenization venues, clearing PT headlines from sUSN, USN, K3 sBOLD, Strata srUSDe, sUSDD and apxUSD.",
      href: "/methodology/yield-changelog/",
    },
    {
      label: "Reserve adapter repairs",
      tag: "coverage",
      description:
        "Seven adapters realigned with upstream changes, DOC and USD3 re-pinned after contract upgrades, KPMG's August reports admitted for PAXG, PYUSD and USDP, and AUDX's Aura Partners report accepted.",
    },
    {
      label: "Cron recovery and memory caps",
      tag: "infra",
      description:
        "One D1 overload no longer cascades into hours of red crons, DEX provider bodies are capped after a 172 MB memory kill, and full publication returns after four supply-less coins were quarantined.",
    },
    {
      label: "Dwellir RPC trial",
      tag: "infra",
      description:
        "Dwellir sponsors a year of RPC access as a metered last-position operator across 29 EVM endpoints, watched by an hourly parity monitor against incumbent operators; Arc joins the chain registry.",
    },
    {
      label: "Registry and funding ledger",
      tag: "coverage",
      description:
        "Twenty pre-launch coins refreshed and two bank-led programmes tracked, taking the registry to 409; msUSD's September depeg low is annotated and two USDC receipts reconciled into the funding ledger.",
    },
  ],
  stats: { totalCommits: 89 },
  commits: [
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
    { hash: "6766a812", message: "fix(yield): stop PT markets posing as native wrapper yield (v8.44)" },
    { hash: "ee9d1743", message: "Update Polaris USDp/GOLDp for domain, X handle, and token rename" },
    { hash: "9d5b9bec", message: "Validate on-chain log data without a nested-quantifier regex" },
    { hash: "4b19d92f", message: "Let a corroborating pool-challenger majority carry depeg recovery" },
    { hash: "9195278f", message: "Recover the DexScreener refresh breaker when its cohort is empty" },
  ],
};
