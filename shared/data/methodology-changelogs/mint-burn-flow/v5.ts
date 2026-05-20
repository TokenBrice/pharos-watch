import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_BURN_FLOW_V5: readonly MethodologyChangelogEntry[] = [
  {
    version: "5.2",
    title: "GYD retirement from active mint/burn coverage",
    date: "2026-04-14",
    effectiveAt: 1776169200,
    summary:
      "GYD was removed from active mint/burn flow tracking after its cross-chain contract incident left the token functionally dead and moved it to the cemetery dataset.",
    impact: [
      "Mint/burn flow configs no longer scan the Ethereum GYD token after the asset moved out of the active stablecoin registry",
      "Public flow coverage counts and stablecoin registry totals now exclude GYD from active surfaces",
      "Historical rows remain in D1 if previously ingested, but current API scope is driven by the active config registry",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.1",
    title: "Canonical-chain mint/burn scope for native issuance tracking",
    date: "2026-04-08",
    effectiveAt: 1775620800,
    summary:
      "Mint/burn coverage now follows each asset's configured issuance chain instead of assuming Ethereum-only scope, with USDai switched to native Arbitrum issuance/redemption tracking and stale non-canonical rows excluded from public aggregates.",
    impact: [
      "USDai mint/burn tracking now runs on Arbitrum as the canonical native issuance chain instead of Ethereum bridge-transfer noise",
      "Aggregate and per-coin APIs now read only configured `(stablecoinId, chainId)` pairs so stale historical rows on non-canonical chains do not contaminate public flow metrics",
      "Cron metadata, coverage helpers, status reconciliation, daily digest, and DEWS mint/burn inputs now honor chain-aware mint/burn scope",
      "Admin backfill auto-selection and explicit config replay now work across the configured issuance-chain set instead of Ethereum-only",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "5.0",
    title: "Bridge-transfer flow exclusion for omnichain tokens",
    date: "2026-04-08",
    effectiveAt: 1775606400,
    summary:
      "Bridge-aware classification now excludes bridge-transfer mints as well as burns, starting with USDai's LayerZero OFT path, and replay/backfill runs can repair previously inserted rows.",
    impact: [
      "LayerZero OFT transfers now mark both the mint-side and burn-side event rows as `flowType='bridge_transfer'` so they drop out of counted economic-flow aggregates",
      "USDai's Ethereum tracker now recognizes the documented USDai OAdapter / LayerZero packet flow instead of treating equal-sized bridge mints and burns as issuance activity",
      "Bridge classification now runs after all parsed rows are assembled for the config chunk, so mint-side bridge rows are visible to the classifier",
      "Replay and backfill persistence now updates `flow_type` on existing rows, allowing post-deploy repair of previously ingested bridge-transfer noise",
    ],
    commits: [],
    reconstructed: false,
  },
];
