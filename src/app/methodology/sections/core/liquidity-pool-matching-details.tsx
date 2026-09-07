import { MethodologyDetails } from "../../methodology-shared";

export function LiquidityPoolMatchingDetails() {
  return (
    <MethodologyDetails summary="Pool Matching & Deduplication">
      <div className="space-y-3">
        <p>
          Dedicated protocol-native sources (Fluid, Balancer, Raydium, Orca, Meteora, PancakeSwap V3, Aerodrome
          Slipstream, and Velodrome Slipstream) are treated as primary-grade inputs and enter scoring before staged or
          fallback discovery sources are merged.
        </p>
        <p>
          Discovery coverage is less page-fragile now: CoinGecko Onchain and GeckoTerminal token crawls read multiple
          bounded pages, and fallback enrichment can activate for weak partial coverage instead of waiting for a strict
          zero-pool outcome. Secondary discovery rows with non-finite, negative, or impossible pool TVL are rejected
          before staging and skipped again at scoring merge time if stale bad data is already present.
        </p>
        <p>
          Stellar classic-AMM discovery uses Horizon with exact, case-preserving <code>CODE:ISSUER</code> identities.
          Those rows receive price and TVL only when the counter-asset is another active tracked classic Stellar
          stablecoin with a usable peg reference and the implied tracked price passes the common plausibility gate.
          Horizon is a capped secondary source with a 200-row response bound and 0.55 fallback-price confidence;
          Soroban contract tokens, Stellar order books, and Soroban-native DEX liquidity remain outside this provider
          and fail closed rather than inheriting synthetic coverage.
        </p>
        <p>
          Matching is chain-aware: `chain + address` resolves first, and symbol fallback is only allowed when it is
          unique on that chain for addressless tokens. If an upstream token already supplies an unknown address, it is
          dropped instead of being remapped by symbol. Pool dedupe uses exact ids plus conservative derived identity
          keys, so legitimate same-pair pools are not collapsed just because their token set matches. Balancer direct
          pools now key exact identity off the API&apos;s real pool `address`, not the 32-byte vault pool id. Provider-specific
          ids with underscores or suffixes are normalized into canonical protocol families before identity matching.
        </p>
        <p>
          Direct-source precedence is also measurement-aware now. A protocol-native pool only replaces an overlapping
          DeFiLlama row when it has measured non-zero 24h volume, which means Slipstream pool-state rows can expand Base
          and Optimism coverage without displacing stronger overlapping DL rows when volume telemetry is absent. Exact
          pool ids from protocol-native sources still stay reserved for later staged-source dedupe even when the direct
          row itself is too small to score, so discovery feeds cannot re-add the same address with incompatible TVL
          semantics.
        </p>
        <p>
          Discovery rows also need authoritative confirmation when they claim a protocol family that already has a clean
          protocol-native fetch on that chain. In practice, GT/CG/DS staging cannot invent new Balancer, Fluid, Raydium,
          Orca, Meteora, PancakeSwap, Aerodrome, or Velodrome pools after the native source succeeded; if that native
          fetch is degraded or unavailable, the scorer fails open and still allows staged recovery rows through.
        </p>
        <p>
          For identity-poor DeFiLlama UUID rows, staged discovery can use the narrow optional-metadata wildcard only when
          both sides are unique on chain, protocol, token set, and pool-shape family. That lets one staged exact-pool-id
          row collapse against one primary row without collapsing parallel same-pair pools.
        </p>
        <p>
          When protocol-native sources expose pool inventory, Balancer, Raydium, Orca, Meteora, PancakeSwap V3, and the
          Slipstream integrations now contribute measured balances and fee detail instead of neutral placeholders.
          Balancer weighted pools are normalized against target token weights before the balance ratio is computed. Fluid
          reads reserves and fee detail from the official DexReservesResolver on Ethereum, Arbitrum, Base, and Polygon,
          while Aerodrome and Velodrome Slipstream read pool state from the on-chain Sugar view contracts on Base and
          Optimism.
        </p>
        <p>
          Canonical Ethereum Uniswap V2 and BSC PancakeSwap V2 pools can publish exact constant-product execution only
          after their factory runtime and exact `getPair` binding are verified. Token order, reserves, and decimals must
          resolve at the same pinned block; other V2 forks and any identity, factory, reserve, price, or read failure
          stay capability-gated instead of inheriting executable depth.
        </p>
        <p>
          Classic Aerodrome execution is limited to volatile pools already present in the Base Aerodrome census. Exact
          models require same-block reviewed factory and implementation runtimes, an exact `getPool(token0, token1,
          false)` binding, `stable = false`, an unpaused factory, and the pool&apos;s dynamic fee. This does not admit generic
          Solidly forks or deployments on Avalanche, Linea, or Sonic.
        </p>
        <p>
          Hook-free Ethereum Uniswap V4 pools can publish measured exact-execution profiles through the separately
          reviewed PoolManager, StateView, and Quoter path. Each score-facing profile binds the exact PoolId, ordered
          currencies, fee, tick spacing, zero hook, pinned runtimes, immutable PoolManager relationships, current pool
          state, and ABI-decoded quote. Hooked pools and other V4 chains remain unsupported, and stale or drifted evidence
          fails closed.
        </p>
        <p>
          Base Aerodrome Slipstream pools can also publish measured exact-execution profiles. Each profile pins the
          reviewed factory and QuoterV2 runtimes, proves the retained pool through the factory&apos;s exact token and
          tick-spacing binding, and revalidates identity, prices, freshness, capacity monotonicity, and the retained TVL
          ceiling before scoring. Mature fresh profiles remain route-only if a pool temporarily rotates out of the display
          shortlist; they never re-enter aggregate liquidity, price consensus, or public target inventory. Any V9 Exit
          use is limited to the current score-eligible exact-route contract. Optimism
          Uniswap V3 has been retired from the maintained source and measured-execution lanes.
        </p>
        <p>
          As of v6.0, the never-score-eligible Solana and Tron native measured-execution lanes (Raydium CLMM, Orca
          Whirlpool, SunSwap V2) and the Fluid measured overlay have been retired. Retained Raydium, Orca, and Fluid
          pools continue to contribute aggregate liquidity, price observations, and shaped exit-route evidence, but no
          native measured-execution profiles are collected or published for them, and the target-only SunSwap census is
          no longer fetched.
        </p>
        <p>
          Repeated sightings of the same physical pool across direct API, staged, and fallback sources are collapsed before
          DEX price aggregation. Exact direct price evidence can rejoin only when the same canonical pool survives final
          scoring and both records clear the price-observation floor; derived or mismatched identities remain excluded. A
          separate challenger snapshot preserves the full retained pool set for depeg checks, instead of relying on the
          visible top-pools subset. Balancer stablecoin pools also get a narrow stable-pair identity fallback when
          DeFiLlama omits the subtype in `balancer-v3`, preventing direct-API stable pools from being double-counted as faux
          weighted rows.
        </p>
        <p>
          Orderbook fallback rows now validate observable ticker quality directly. CoinGecko deprecated `trust_score`, so
          Pharos filters those tickers by freshness flags, finite USD price/volume, exchange identity, and USD-equivalent
          quote assets instead of relying on a legacy badge. The scoring-cron orderbook fallback is reserved for absent,
          no-price, or tiny DEX coverage; weak but already-covered DEX assets stay on the on-chain repair path instead of
          receiving time-budget-dependent centralized synthetic books.
        </p>
        <p>
          PancakeSwap V3 volume now uses a bounded trailing-hour window from the official subgraph&apos;s
          `poolHourDatas.volumeUSD` buckets instead of the latest `poolDayDatas` row, so intraday volume no longer decays
          toward zero between UTC day rollovers.
        </p>
        <p>
          Large retained pools must clear the minimum 24h volume floor even when volume is marked unmeasured. After bad
          pools are filtered and secondary-source TVL caps are applied, every exported aggregate and score input is rebuilt
          from the retained pool set.
        </p>
        <p>
          Curve balance, registry, token-price, and metapool TVL enrichment is applied only to Curve DeFiLlama rows.
          Non-Curve rows that share the same token symbols as a Curve pool keep their own mechanism type and TVL.
        </p>
        <p>
          Address-grade plain Curve StableSwap-NG pools with rate-bearing inputs can publish a route model only after fresh
          same-block state verifies `get_balances`, amplification, stored rates, ordered coins, and static fee state. Rate
          scaling adjusts both balances and references; Curve deducts its captured static fee after the full-input
          invariant. Stale, unpinnable, identity-mismatched, or dynamic-fee state remains capability-gated. Metapools,
          CryptoSwap, legacy pools, and all other unreviewed Curve shapes are not widened.
        </p>
        <p>
          Explicitly reviewed Curve metapools can instead publish exact same-notional execution through pinned
          <code className="text-xs"> get_dy_underlying</code> calls. LUSD/3Crv uses this path from v6.2: the producer
          verifies its legacy factory registration, implementation, 3pool base relationship, coin order, decimals, and
          runtime code before quoting LUSD to USDC. From v6.3, multiple Curve registry views of the same canonical pool
          address collapse to one physical fingerprint candidate, while distinct addresses with the same coin set remain
          ambiguous. Reported TVL is never treated as executable capacity, and any proof or quote failure leaves the route
          gated.
        </p>
        <p>
          Coverage confidence is measurement-aware. Instead of a fixed score by source family, Pharos now weights how much
          retained TVL has measured balances and prices, how broad the protocol mix is, and how much of the row depends on
          synthetic or freshness-decayed fallback liquidity.
        </p>
      </div>
    </MethodologyDetails>
  );
}
