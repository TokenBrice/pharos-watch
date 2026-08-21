import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const MINT_BURN_FLOW_V6: readonly MethodologyChangelogEntry[] = [
  {
    version: "6.191",
    title: "Base Dollar native flow coverage",
    date: "2026-08-21",
    effectiveAt: 1787270400,
    summary:
      "Base Dollar joins the extended mint/burn lane on its canonical Base deployment from the verified creation block, with a protocol-scale threshold that retains ordinary borrower issuance while filtering sub-economic interest-distribution churn.",
    impact: [
      "BD Transfer mints and burns are scanned from Base block 49,406,521, the verified CREATE2 deployment block for the canonical token.",
      "The 100 BD threshold sits below Base Dollar's 200 BD minimum debt and retains observed 300, 1,000, and 2,700 BD borrower mints that the generic 10,000-unit long-tail threshold would discard.",
      "Public flow coverage now includes canonical issuance chains on Ethereum, Arbitrum, and Base; scoring formulas, bridge classification, and Bank Run Gauge weighting are unchanged.",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.19",
    title: "Bank Run Gauge: one producer, one universe",
    date: "2026-08-10",
    effectiveAt: 1786314652,
    summary:
      "The Bank Run Gauge is now computed once, by the /api/mint-burn-flows publication, and the daily digest re-bins that publication instead of recomputing a second composite from mint_burn_hourly over a narrower coin set with global peg-bucket supply weights.",
    impact: [
      "Previously the same trading day could carry two different gauge scores and bands: the API scored every active tracked mint/burn pair weighted by tracked-chain circulating supply, while the digest restricted to the core-aggregate set on canonical chains weighted by global supply",
      "Twenty tracked coins the digest silently excluded now contribute, and 92 coins deployed beyond their tracked mint/burn chains are weighted by observed tracked-chain supply rather than their global total; baseline derivation also unifies on observed-day averaging",
      "The publication carries a per-chain 24-hour net-flow breakdown over the same universe, so the digest's top-chains ranking is no longer derived independently",
      "Digest gauge values before this change are not comparable to values after it; the 7-day gauge trajectory and weekly recap range show a one-time discontinuity while the pre-cutover archive ages out",
      "Fail-closed: a gauge publication older than 24 hours (or unparseable) is dropped and the digest run marks degraded instead of republishing a wrong gauge; older than 2 hours is used but flagged",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.18",
    title: "Retention-safe quiet coverage maturity",
    date: "2026-07-28",
    effectiveAt: 1785196800,
    summary:
      "Mint/burn coverage maturity now uses completed block-scan span when a quiet asset has no retained event row, preventing retention from sending fully observed configs back to bootstrapping.",
    impact: [
      "A quiet config with no retained hourly event remains full once its sync cursor proves at least 30 days of configured-chain history",
      "Genuinely young quiet configs still progress from bootstrapping to partial history before reaching full coverage",
      "XAUT now reports its mature, near-head Ethereum coverage instead of bootstrapping after its last hourly event aged beyond the 95-day aggregate retention window",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.17",
    title: "Tx-context shortfall exclusion recovery",
    date: "2026-06-07",
    effectiveAt: 1780790400,
    summary:
      "Bridge-aware mint/burn ingestion now handles residual transaction-context shortfalls per row, excluding unresolved rows from economic flow while allowing resolved rows and the sync frontier to proceed.",
    impact: [
      "Rows with unavailable tx or receipt context are persisted as `flow_type='bridge_transfer'`, with unresolved burns marked `review_required` / `tx-context-unavailable`",
      "Resolved rows in the same bridge-aware config window are no longer withheld because of one unavailable transaction context",
      "Cron metadata continues to expose `bridgeClassification.txContextShortfalls` and `bridgeClassification.deferredRows` as unavailable-context diagnostics rather than provider-error counts",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.16",
    title: "Bridge context budget recovery",
    date: "2026-06-07",
    effectiveAt: 1780790400,
    summary:
      "Bridge-aware critical mint/burn configs now resolve transaction and receipt context with one Alchemy batch request per transaction and have a bounded larger critical budget for high-volume configs.",
    impact: [
      "High-volume bridge-aware configs such as Ethereum USDC can catch up without repeatedly deferring all parsed rows under the old 60-request cap",
      "Bridge classification still fails closed for counted standard flow when transaction or receipt context is genuinely unavailable; unavailable rows remain excluded from economic-flow aggregates",
      "The cron-wide request ceiling remains 200, while bridge-aware critical configs may use up to 150 requests so other critical configs retain run headroom",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.15",
    title: "Bridge tx-context shortfall guard",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary:
      "Bridge-aware mint/burn ingestion now treats unresolved transaction context as a classification shortfall instead of publishing bridge candidates as standard flow.",
    impact: [
      "Rows from bridge-enabled configs are not persisted when tx or receipt context cannot be resolved, keeping unclassified bridge mints out of counted economic flow",
      "Affected configs remain unsatisfied and do not advance their sync frontier, allowing a later run to retry the same block range once RPC context is available",
      "Cron metadata exposes `bridgeClassification.txContextShortfalls` and `bridgeClassification.deferredRows` so status diagnostics show classification gaps explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "6.14",
    title: "Bridge config validation fail-closed",
    date: "2026-06-06",
    effectiveAt: 1780704000,
    summary:
      "Bridge-detection config validation now aborts module load on malformed addresses, topics, or selectors instead of logging and continuing with silently disabled bridge filtering.",
    impact: [
      "Malformed bridge metadata can no longer let CCIP, CCTP, or LayerZero bridge mints/burns leak into standard economic flow counts",
      "Mint/burn cron metadata now publishes `bridgeValidationErrors: 0` on healthy runs so the validation surface is explicit in status diagnostics",
      "Checked-in bridge configs are covered by a module-load validation regression test before deployment",
    ],
    commits: [],
    reconstructed: false,
  },
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
