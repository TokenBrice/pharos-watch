import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const YIELD_METHODOLOGY_V7: readonly MethodologyChangelogEntry[] = [
  {
    version: "7.48",
    title: "dTRINITY sdUSD Multi-Chain Weighted Source",
    date: "2026-05-13",
    effectiveAt: 1778630400,
    summary:
      "dTRINITY dUSD yield now publishes a TVL-weighted sdUSD source across the Ethereum and Fraxtal dStake vaults instead of using only the Ethereum DeFiLlama row.",
    impact: [
      "`dusd-dtrinity` resolves an exact DeFiLlama weighted pool group for Ethereum and Fraxtal sdUSD",
      "The synthetic source key starts a new history series so prior Ethereum-only rows are not treated as equivalent 30-day samples",
      "The dUSD metadata entry stays unchanged because its checked-in collateral and contract data already documents chain-isolated deployments",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.47",
    title: "Avant savUSD ownership correction",
    date: "2026-05-13",
    effectiveAt: 1778630400,
    summary:
      "Avant yield is now attributed to the tracked savUSD senior-tranche wrapper rather than base avUSD, matching Avant's current token documentation.",
    impact: [
      "`savusd-avant` now owns the Avant native savings pool directly in the yield manifest",
      "`avusd-avant` is no longer marked yield-bearing because avUSD is the non-yield base asset and savUSD is the yield-accruing route",
      "Parent-side `avusd-avant` savUSD variant and pool mappings were removed so new yield history publishes under the tracked savUSD asset",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.46",
    title: "Zephyr ZYS direct yield source",
    date: "2026-05-12",
    effectiveAt: 1778594800,
    summary:
      "Zephyr yield is now attributed to the tracked ZYS yield-share wrapper rather than base ZSD, using Zephyr Scanner's historical-return API as a direct protocol source.",
    impact: [
      "`zys-zephyr-protocol` is tracked as a yield-bearing NAV wrapper over `zsd-zephyr-protocol`",
      "`protocol-api:zys-zephyr-protocol` reads Zephyr Scanner one-day effective APY and publishes it as `Zephyr Scanner ZYS returns`",
      "`zsd-zephyr-protocol` remains non-yield-bearing so the base stablecoin does not receive the wrapper's APY row",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.45",
    title: "USG Yield Ownership Correction",
    date: "2026-05-08",
    effectiveAt: 1778198400,
    summary:
      "Tangent USG is no longer treated as a yield-bearing asset because yield accrues in the separate sUSG savings wrapper, not in USG itself.",
    impact: [
      "`usg-tangent` now carries `yieldBearing: false`, matching Tangent's USG/sUSG split",
      "`usg-tangent` is removed from intentional yield-gap coverage because it is no longer part of the yield-bearing manifest universe",
      "The intentional-gap manifest remains reserved for assets that are actually marked yield-bearing but lack a reliable runtime APY source",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.44",
    title: "Solayer sUSD Treasury fallback coverage",
    date: "2026-05-05",
    effectiveAt: 1777939200,
    summary:
      "Solayer sUSD is covered through the rate-derived Treasury fallback lane, while newly added reward-bearing account or restricted strategy assets stay out of runtime yield until a reliable APY source is wired.",
    impact: [
      "`susd-solayer` now has an explicit rate-derived T-bill fallback strategy in the yield manifest",
      "Reward-bearing account products and restricted strategy tokens without reliable public APY telemetry are not marked as runtime yield-bearing, so they do not publish misleading zero-strategy yield rows",
      "The active yield-bearing invariant still requires every marked asset to have a runtime strategy before it can enter live yield rankings",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.43",
    title: "Tracked savings wrappers own their native APY history",
    date: "2026-04-22",
    effectiveAt: 1776816000,
    summary:
      "Base stablecoins no longer publish tracked savings-wrapper APY through parent-owned config or historical series when the wrapper is itself a tracked asset.",
    impact: [
      "`sUSDe`, `sUSDS`, `sDAI`, `sfrxUSD`, and `scrvUSD` now own the native runtime pool and deterministic rate readers that used to live on `USDe`, `USDS`, `DAI`, `frxUSD`, and `crvUSD`",
      "Those five base assets no longer advertise wrapper-owned `yieldBearing` metadata or serve the old wrapper APY series through `/api/yield-history`; the historical discontinuity is intentional and reflects corrected ownership rather than a missing backfill",
      "Parent-side wrapper source keys are filtered immediately at read time and purged on the hourly yield sync path, so misattributed pre-handoff rows do not linger under the base ids after rollout",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.42",
    title: "First-Class Risk Wrapper Yield Assets",
    date: "2026-04-21",
    effectiveAt: 1776777600,
    summary:
      "Yield wrappers whose holder risk differs materially from the base stablecoin now own their yield rows directly instead of publishing through the base asset.",
    impact: [
      "Cap `stcUSD`, GAIB `sAID`, Main Street `msY`, and K3 `sBOLD` are tracked as first-class yield-bearing NAV/wrapper assets rather than as native yield on cUSD, AID, msUSD, or BOLD",
      "`stUSDS` uses the generic on-chain ERC-4626 exchange-rate reader because the risk-capital token is distinct from Sky's plain sUSDS savings wrapper and has no standalone DeFiLlama stablecoin row",
      "Aave Umbrella `stkGHO` is inventoried as an intentional runtime-yield gap until a reliable reward APY source is available, avoiding a misleading zero-yield publication",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.41",
    title: "On-Chain Bootstrap Seeds Excluded From Rolling APY",
    date: "2026-04-21",
    effectiveAt: 1776729600,
    summary:
      "Deterministic on-chain seed rows used only to establish a 7-day exchange-rate anchor no longer count as observed zero-yield samples in rolling APY, excess-yield, stability, or PYS calculations.",
    impact: [
      "On-chain rows whose first observations were bootstrap `0%` APY placeholders now compute `apy7d`, `apy30d`, `excessYield`, yield stability, and PYS from real APY samples once an anchor exists",
      "`excessYield` remains defined as `apy30d - benchmarkRate`; detail-page and hero-chip copy now labels it as 30-day based so it is not confused with current APY spread",
      "Historical seed rows remain in `yield_history` for exchange-rate anchoring, but the evaluator excludes rows with `data_source='onchain'`, `exchange_rate IS NOT NULL`, `apy = 0`, and `apy_base IS NULL` from rolling stats",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.4",
    title: "Pre-Launch Lending Overrides Quarantined",
    date: "2026-04-13",
    effectiveAt: 1776038400,
    summary:
      "Pre-launch assets are now isolated from deterministic lending override publication, so upcoming coins cannot appear in live yield rankings before launch.",
    impact: [
      "`pusd-polaris` is now an explicit pre-launch intentional gap instead of resolving through a deterministic Silo v2 lending override",
      "Yield source resolution now skips configured explicit or deterministic lending candidates unless the target asset is in the active stablecoin universe",
      "The stablecoin metadata registry now keeps pre-launch assets in per-coin files with `status: \"pre-launch\"`; the legacy `shared/data/stablecoins/pre-launch.json` shell stays empty while upcoming pages and launch alerts continue to work",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.3",
    title: "scrvUSD Current-Rate On-Chain Reader",
    date: "2026-04-11",
    effectiveAt: 1775892600,
    summary:
      "Curve Savings crvUSD now uses a dedicated Yearn V3 profit-unlock reader for current APY instead of the generic 7-day ERC-4626 exchange-rate delta.",
    impact: [
      "Legacy parent-side `crvusd-curve` rows are quarantined from the generic `convertToAssets(1e18)` Tier 1 reader because that trailing 7-day delta understated Curve's current savings APY",
      "The new `onchain:scrvusd-curve:scrvusd-current-rate` source reads scrvUSD vault `totalSupply`, `totalAssets`, `profitUnlockingRate`, and `fullProfitUnlockDate` to compute the current daily-compounded APY",
      "The existing DeFiLlama scrvUSD pool remains as a curated alternative and fallback row, while source-specific history starts fresh under the new current-rate source key",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.2",
    title: "USD.AI Base/Yield Token Split",
    date: "2026-04-04",
    effectiveAt: 1775314800,
    summary:
      "Yield coverage now treats sUSDai as its own tracked yield-bearing NAV token instead of hanging the savings venue off the base USDai page via wrapper indirection.",
    impact: [
      "`usdai-usd-ai` is no longer treated as a yield-bearing wrapper host, so base USDai stops inheriting sUSDai's savings pool as its native yield source",
      "New tracked asset `susdai-usd-ai` now owns the existing USD.AI savings pool mapping directly, aligning yield rankings with the dedicated sUSDai detail page and nav-token semantics",
      "The stale USD.AI wrapper config that pointed at Arbitrum PYUSD as the `sUSDai` variant address is removed, eliminating a concrete address-level misbinding",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.1",
    title: "Explicit Intentional Gaps For Pre-Launch Yield Assets",
    date: "2026-04-03",
    effectiveAt: 1775214000,
    summary:
      "Pre-launch yield-bearing assets without a live runtime source are now emitted as explicit intentional manifest gaps instead of appearing as covered entries with zero strategies.",
    impact: [
      "`bd-basedollar` is now classified the same way as other pre-launch yield-bearing assets with no live runtime source, so the manifest no longer reports it as a covered entry with zero strategies",
      "Coverage audits and operator tooling continue to inventory every yield-bearing asset, but pre-launch gaps are now fail-closed and explicit rather than implicit",
      "The public yield methodology docs and timeline now call out the intentional-gap treatment for these pre-launch assets",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "7.0",
    title: "Supply-Relative Size Gates For Published Lending Suggestions",
    date: "2026-04-03",
    effectiveAt: 1775210400,
    summary:
      "Published lending-opportunity rows now require observable venue TVL and must be large enough relative to the tracked stablecoin's circulating supply before they can surface as live recommendations.",
    impact: [
      "For tracked stablecoins, lending-opportunity rows now require `sourceTvlUsd` and must clear `max(existing absolute floor, 0.1% of current supply)` before publication",
      "This applies across auto-discovered DeFiLlama lending markets, deterministic exact-pool overrides, and supplemental protocol-native lending venues",
      "TVL-less protocol suggestions no longer fail open into live recommendations; until venue size is observable they are omitted from published lending-opportunity coverage",
      "Yield methodology docs and changelog entries now document the new supply-relative recommendation gate explicitly",
    ],
    commits: [],
    reconstructed: false,
  },
];
