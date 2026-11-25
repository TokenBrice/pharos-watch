import { DEX_VOLUME_COVERAGE_MIN } from "@shared/lib/dex-volume-availability";
import { MethodologyDetails, MethodologyFacts, MethodologyPreconditions } from "../../methodology-shared";

export function LiquidityOverview() {
  return (
    <>
      <p>
        Composite 0&ndash;100 score measuring DEX liquidity depth per stablecoin, published hourly alongside DEX-implied
        prices. The score aggregates genuine pool data across major DEXes and chains.
      </p>
      <MethodologyDetails summary="Current pool admission and measurement rules">
        <p>
          Liquidity v7.56 generalizes v7.51&apos;s exact Curve pool-address identification across all DeFiLlama Curve
          pools, with fail-closed below-floor twin guards and a &lt;2h neutral outage hold while keeping DeFiLlama Yields
          as the measurement authority. Each physical pool contributes once, even when Curve omits a twin&apos;s
          valuation. TVL trends compare observations within the same measurement epoch so this cutover cannot appear as a
          market move.
        </p>
        <p>
          Dead or explicitly blocked DEX slugs such as Bunni are excluded upstream from crawl intake, retained pools,
          challenger snapshots, and DEX-implied price publication instead of being treated as low-quality live venues.
          The same block covers non-AMM venues whose reported &ldquo;pool&rdquo; reserves are not executable depth: NEAR
          Intents pairs are priced from the settlement contract&rsquo;s shared custody of the quote asset, so they never
          count as liquidity.
        </p>
        <p>
          Since v6.93, CoinGecko exchange tickers supply price evidence only, not TVL, pools, liquidity volume, source mix,
          coverage or orderbook depth. Legacy synthetic rows are excluded too. A ticker-only asset is liquidity-unobserved,
          not measured zero; the first publication can show a one-time policy TVL step rather than a market withdrawal.
          The 2026-10-08 registry inventory found ten ticker-only assets, with USDGO, YLDS and Gate GUSD each above $1M of
          raw ticker TVL. That inventory is not a forecast of published TVL. Safety formula is unchanged, and improved
          Safety Score stability has not been measured.
        </p>
        <p>
          Pool quality uses the same retained TVL throughout. Curve metapools count their full TVL, base-pool LP leg
          included. Balance health penalises a pool only for holding too much of the tracked coin, since extra
          counter-asset is more exit depth; an incomplete balance capture stays neutral and unmeasured. Remembered pools keep their measured imbalance penalties, and measured zero depth is never
          replaced by raw TVL. Exact EVM execution keeps its original capture clock; validated source headers for
          QuoterV2, Uniswap V4 and Curve CryptoSwap enforce the existing three-hour source-age ceiling. Malformed or
          incomplete pool censuses cannot certify deployment-wide absence or erase independently valid pools.
        </p>
        <p>
          Measured execution requires exact retained-pool identity, current admitted valuation and coherent
          canonical chain/block/hash proof. History contributes only while each original quote remains fresh at
          assessment; new publications cannot renew it. Non-USD peg fallback uses fresh non-future per-peg FX
          under its source cadence, not a diagnostic rate or global cache clock. Unsupported hash reads,
          number-only proof and unavailable method probes remain unavailable, not latest-state substitutes or
          zero capacity. Carried spots cannot manufacture current output value.
        </p>
        <p>
          Methodology v6.95 adds pinned reviewed targets on already-active Pancake V3 and Uniswap V3 families.
          Active targets still need quote-time identity, freshness and execution checks; shadow pools remain
          score-ineligible. Reviewed Aquarius Soroban identities supply supplemental non-exhaustive coverage
          (CHFSAFO left active collection when delisted under listing policy 2.0).
          A missing liquidity row schedules maintenance, not a zero-liquidity observation. Component weights,
          budgets, cadence and retained-TVL basis are unchanged. Fresh producer observations and final
          fixed-clock comparison remain required. Activation: October 14, 2026 12:40 UTC (release cut; 1791981600).
        </p>
      </MethodologyDetails>
    </>
  );
}

export function LiquidityPreconditions() {
  return (
    <>
      <MethodologyFacts
        facts={[
          { label: "Update cadence", value: "Score, source stage and DEX-implied prices: hourly" },
          { label: "Signal mix", value: "5 weighted liquidity components" },
          { label: "Output", value: "0-100 DEX depth score" },
        ]}
      />
      <MethodologyPreconditions
        facts={[
          {
            label: "Minimum data",
            value: `Volume Activity requires a complete 24h window or at least ${DEX_VOLUME_COVERAGE_MIN * 100}% retained-TVL coverage (inclusive); otherwise the composite is not rated`,
          },
          {
            label: "Durability history",
            value: "Missing stability history defaults to neutral 50 sub-scores; this does not bypass the volume-coverage requirement",
          },
          {
            label: "Required sources",
            value: "Pool TVL/volume/chain data plus mechanism and pair-quality metadata",
          },
          {
            label: "Failure behavior",
            value:
              "Standalone DEX rows can be unavailable. In Safety Score Exit, missing or unsupported comparable-route evidence receives the bounded floor and exit-unverified ceiling; a reviewed-complete portfolio with no viable route scores Exit 0, except that an open route with an unproven settlement bound takes the bounded floor and exit-unverified ceiling.",
          },
        ]}
      />
    </>
  );
}
