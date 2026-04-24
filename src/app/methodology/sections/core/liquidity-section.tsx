import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";
import { MethodologyDetails, MethodologyFacts, MethodologySectionShell, WorkedExample } from "../../methodology-shared";
import { LiquidityTechnicalDetails } from "./liquidity-technical-details";
export const CONTENT_MARKDOWN = `## Liquidity Score\n\nThe Liquidity Score measures how safely a stablecoin can exit through decentralized markets. It combines TVL depth, volume activity, pool quality, durability, and pair diversity into a 0-100 score.\n\nTVL depth uses log-scale scoring so small assets can improve without requiring blue-chip depth, while very deep pools still receive credit. Volume rewards active markets. Pool quality adjusts for mechanism type, pool balance, pair quality, and risky counterparties. Durability measures persistence across observations, and pair diversity penalizes concentration in one venue or one unstable route.\n\nDiscovery is source-aware. Pharos stages pools from DefiLlama, direct protocol APIs, CoinGecko on-chain data, GeckoTerminal, DexScreener, and curated DEX sources, then deduplicates by exact pool identity or conservative derived identity. Thin, stale, or identity-poor pools remain visible for diagnostics but do not receive the same scoring weight as durable high-quality venues.\n`;
export function LiquidityMethodologySection() {
  return (
    <MethodologySectionShell
      id="liquidity-methodology"
      title="Liquidity Score"
      versionLabel={LIQUIDITY_METHODOLOGY_VERSION_LABEL}
      changelogPath={LIQUIDITY_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when liquidity formula weights, source inclusion rules, or TVL normalization logic changes."
      accentClassName="border-l-sky-500"
      badgeClassName="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400"
      changelogClassName="hover:text-sky-700 dark:text-sky-400"
    >
      <p>
        Composite 0&ndash;100 score measuring DEX liquidity depth per stablecoin, updated every 30 minutes. Aggregates
        pool data across all major DEXes and chains.
      </p>
      <p>
        Dead or explicitly blocked DEX slugs such as Bunni are excluded upstream from crawl intake, retained pools,
        challenger snapshots, and DEX-implied price publication instead of being treated as low-quality live venues.
      </p>
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
            zero-pool outcome.
          </p>
          <p>
            Matching is chain-aware: `chain + address` resolves first, and symbol fallback is only allowed when it is unique
            on that chain for addressless tokens. If an upstream token already supplies an unknown address, it is dropped
            instead of being remapped by symbol. Pool dedupe uses exact ids plus conservative derived identity keys, so
            legitimate same-pair pools are not collapsed just because their token set matches. Balancer direct pools now key
            exact identity off the API&apos;s real pool `address`, not the 32-byte vault pool id. Provider-specific ids with
            underscores or suffixes are normalized into canonical protocol families before identity matching.
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
            Repeated sightings of the same physical pool across direct API, staged, and fallback sources are collapsed
            before DEX price aggregation. A separate challenger snapshot preserves the full retained pool set for depeg
            checks, instead of relying on the visible top-pools subset. Balancer stablecoin pools also get a narrow
            stable-pair identity fallback when DeFiLlama omits the subtype in `balancer-v3`, preventing direct-API stable
            pools from being double-counted as faux weighted rows.
          </p>
          <p>
            Orderbook fallback rows now validate observable ticker quality directly. CoinGecko deprecated `trust_score`, so
            Pharos filters those tickers by freshness flags, finite USD price/volume, exchange identity, and USD-equivalent
            quote assets instead of relying on a legacy badge.
          </p>
          <p>
            PancakeSwap V3 volume now uses a bounded trailing-hour window from the official subgraph&apos;s
            `poolHourDatas.volumeUSD` buckets instead of the latest `poolDayDatas` row, so intraday volume no longer decays
            toward zero between UTC day rollovers.
          </p>
          <p>
            After bad pools are filtered and secondary-source TVL caps are applied, every exported aggregate and score input
            is rebuilt from the retained pool set. That keeps filtered or downscaled pools from lingering in the final score
            through stale pre-filter totals.
          </p>
          <p>
            Curve balance, registry, token-price, and metapool TVL enrichment is applied only to Curve DeFiLlama rows.
            Non-Curve rows that share the same token symbols as a Curve pool keep their own mechanism type and TVL.
          </p>
          <p>
            Coverage confidence is measurement-aware. Instead of a fixed score by source family, Pharos now weights how much
            retained TVL has measured balances and prices, how broad the protocol mix is, and how much of the row depends on
            synthetic or freshness-decayed fallback liquidity.
          </p>
        </div>
      </MethodologyDetails>
      <MethodologyFacts
        facts={[
          { label: "Update cadence", value: "30m refresh" },
          { label: "Signal mix", value: "5 weighted liquidity components" },
          { label: "Output", value: "0-100 DEX depth score" },
        ]}
      />
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
        <MethodologyFacts
          facts={[
            {
              label: "Minimum data",
              value: "No hard minimum in scorer; missing stability history defaults to neutral 50 sub-scores",
            },
            {
              label: "Required sources",
              value: "Pool TVL/volume/chain data plus mechanism and pair-quality metadata",
            },
            {
              label: "Failure behavior",
              value: "If both DEX liquidity and eligible redemption evidence are unavailable, the report-card Liquidity / Exit dimension is NR",
            },
          ]}
        />
      </div>
      <WorkedExample summary="Worked example (verified against computeLiquidityScore)">
        <p className="font-mono">
          Inputs: effectiveTVL=$10M, TVL=$20M, marketCap=$100M, volume24h=$1M, qualityTVL=$12M, durability=70, pools=8
        </p>
        <p className="font-mono">depthRatio=10M/100M=10%, tvlDepth=35&times;log10(0.10/0.0007)=75</p>
        <p className="font-mono">vtRatio=1M/20M=5%, volume=38&times;(log10(0.05)+3)=65</p>
        <p className="font-mono">retention=12M/20M=60%, quality=(0.60&minus;0.15)/0.65&times;100=69</p>
        <p className="font-mono">diversity=min(100,8&times;5)=40</p>
        <p className="font-mono">
          score=round(0.30&times;75+0.20&times;65+0.20&times;69+0.20&times;70+0.10&times;40)=67
        </p>
        <p>
          Result: <span className="text-foreground">Liquidity score 67</span>.
        </p>
      </WorkedExample>

      <LiquidityTechnicalDetails />
    </MethodologySectionShell>
  );
}
