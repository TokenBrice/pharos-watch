import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_BURN_FLOW_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.13",
    title: "USD-valued largest-event guard",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary:
      "The public 24-hour largest-event field now considers only rows with resolved USD valuation, preventing raw token amounts from being rendered as dollars.",
    impact: [
      "Aggregate `/api/mint-burn-flows` excludes `amount_usd IS NULL` rows from largest-event selection",
      "The shared largest-event selector ranks by `amount_usd` only and no longer falls back to raw native token amount",
      "Unpriced mint/burn rows remain available for remediation and event-ledger diagnostics, but they do not populate the USD largest-event table column",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.12",
    title: "Cadence-based coverage lag classification",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary:
      "Per-coin mint/burn coverage now marks established configs as lagging once block progress falls beyond the public freshness cadence, and reports unknown coverage when current chain-head metadata is unavailable.",
    impact: [
      "Ethereum mint/burn coverage no longer waits roughly 10,000 blocks before surfacing a stuck established config as lagging",
      "Coins with missing current chain-head metadata no longer continue to report full coverage solely from historical sync state",
      "The public flows table, coverage matrix, and flow receipt now expose an `unknown` coverage status for configured assets whose current lag cannot be trusted",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.11",
    title: "yBOLD extended transfer coverage",
    date: "2026-05-12",
    effectiveAt: 1778608800,
    summary:
      "Yearn BOLD (yBOLD) now has extended Ethereum mint/burn tracking through standard ERC-20 zero-address Transfer events.",
    impact: [
      "Adds yBOLD to the extended mint/burn config registry using the shared Ethereum contract metadata",
      "Tracks yBOLD share issuance and redemption separately from base BOLD's mint/burn flow so wrapper activity does not disappear into the parent asset",
      "Keeps bridge detection unchanged because the tracked yBOLD deployment is the single Ethereum vault share token",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.1",
    title: "USG extended transfer coverage",
    date: "2026-05-08",
    effectiveAt: 1778198400,
    summary:
      "Tangent USD (USG) now has extended Ethereum mint/burn tracking from its reviewed deployment block using standard ERC-20 zero-address Transfer events.",
    impact: [
      "Adds USG to the extended mint/burn config registry with a reviewed deployment-block start bound",
      "Captures the initial 40.02M USG zero-address mint history plus future USG supply changes through the standard Transfer decoder",
      "Keeps bridge and custom-event handling unchanged; no USG bridge classifier is configured because only the Ethereum token contract is currently tracked",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.0",
    title: "Bridge classifier parity, LayerZero endpoint-only signal, canonical-chain gauge weighting",
    date: "2026-04-17",
    effectiveAt: 1776425040,
    summary:
      "Bridge classification now tags both mint and burn rows for CCIP/CCTP transactions, the LayerZero classifier recognizes endpoint-only fingerprints, and the Bank Run Gauge weights coins by their tracked-chain circulating supply rather than global supply. Atomic-roundtrip detection now requires mint/burn totals to match within 0.5%, and custom-event counterparty extraction supports unindexed address parameters.",
    impact: [
      "CCIP and CCTP bridge mints now tag as `flow_type='bridge_transfer'` (previously leaked into economic mint flow for USDC, EURC, USDO, USD1, avUSD, ZCHF)",
      "LayerZero classifier accepts endpoint-emitter signal alone, catching Executor-only mint patterns previously missed on USDai-Arbitrum",
      "Bank Run Gauge weights each coin's intensity by its circulating supply on tracked-chain scope only (e.g., USDC weighted by Ethereum supply, not global $36B+ total)",
      "Atomic-roundtrip detection requires sum(mint) and sum(burn) to match within 0.5% — partial same-tx mix is preserved as economic flow rather than erased",
      "Custom-event counterparty extraction now supports unindexed address parameters (reUSD `Deposited` user address no longer null)",
      "Historical rows reclassified via `/api/backfill-mint-burn` replay and `/api/reclassify-atomic-roundtrips` after deploy",
    ],
    commits: [],
    reconstructed: false,
  },
];
