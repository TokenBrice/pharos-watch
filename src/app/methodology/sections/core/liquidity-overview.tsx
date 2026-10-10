import { DEX_VOLUME_COVERAGE_MIN } from "@shared/lib/dex-volume-availability";
import { MethodologyFacts, MethodologyPreconditions } from "../../methodology-shared";

export function LiquidityOverview() {
  return (
    <>
      <p>
        Composite 0&ndash;100 score measuring DEX liquidity depth per stablecoin, published hourly alongside DEX-implied
        prices. The score aggregates genuine pool data across major DEXes and chains.
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
        Pool quality uses the same retained TVL scope throughout. For Curve metapools that exclude base-pool TVL,
        full-pool balances are not matching evidence: absent a retained-scope measurement, balance stays neutral
        and unmeasured. Remembered pools keep their measured imbalance penalties, and measured zero depth is never
        replaced by raw TVL. Exact EVM execution keeps its original capture clock; validated source headers for
        QuoterV2, Uniswap V4 and Curve CryptoSwap enforce the existing three-hour source-age ceiling. Malformed or
        incomplete pool censuses cannot certify deployment-wide absence or erase independently valid pools.
      </p>
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
              "Standalone DEX rows can be unavailable. In V10 Exit, missing or unsupported comparable-route evidence receives the bounded floor and exit-unverified ceiling; a reviewed-complete portfolio with no viable route scores Exit 0, except that an open route with an unproven settlement bound takes the bounded floor and exit-unverified ceiling.",
          },
        ]}
      />
    </>
  );
}
