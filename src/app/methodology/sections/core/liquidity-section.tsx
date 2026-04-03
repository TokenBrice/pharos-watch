import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";
import { MethodologyDetails, MethodologyFacts, MethodologySectionShell, WorkedExample } from "../../methodology-shared";

export function LiquidityMethodologySection() {
  return (
    <MethodologySectionShell
      id="liquidity-methodology"
      title="Liquidity Score"
      versionLabel={LIQUIDITY_METHODOLOGY_VERSION_LABEL}
      changelogPath={LIQUIDITY_METHODOLOGY_CHANGELOG_PATH}
      versionNote="Version increments when liquidity formula weights, source inclusion rules, or TVL normalization logic changes."
      accentClassName="border-l-cyan-500"
      badgeClassName="border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400"
      changelogClassName="hover:text-cyan-700 dark:text-cyan-400"
    >
      <p>
        Composite 0&ndash;100 score measuring DEX liquidity depth per stablecoin, updated every 30 minutes. Aggregates
        pool data across all major DEXes and chains.
      </p>
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
        legitimate same-pair pools are not collapsed just because their token set matches.
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
        After bad pools are filtered and secondary-source TVL caps are applied, every exported aggregate and score input
        is rebuilt from the retained pool set. That keeps filtered or downscaled pools from lingering in the final score
        through stale pre-filter totals.
      </p>
      <p>
        Coverage confidence is measurement-aware. Instead of a fixed score by source family, Pharos now weights how much
        retained TVL has measured balances and prices, how broad the protocol mix is, and how much of the row depends on
        synthetic or freshness-decayed fallback liquidity.
      </p>
      <MethodologyFacts
        facts={[
          { label: "Update cadence", value: "30m refresh" },
          { label: "Signal mix", value: "6 weighted liquidity components" },
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
              value: "If liquidity score is null/missing, report-card liquidity dimension is NR",
            },
          ]}
        />
      </div>
      <WorkedExample summary="Worked example (verified against computeLiquidityScore)">
        <p className="font-mono">
          Inputs: effectiveTVL=$25M, TVL=$20M, volume24h=$8M, qualityTVL=$18M, durability=68, pools=12
        </p>
        <p className="font-mono">tvlDepth=67.96, volume=63.37, quality=65.11, pair=60</p>
        <p className="font-mono">score=round(0.35*67.96+0.20*63.37+0.225*65.11+0.15*68+0.075*60)=66</p>
        <p>
          Result: <span className="text-foreground">Liquidity score 66</span>.
        </p>
      </WorkedExample>

      <MethodologyDetails summary="Technical details: component weights, TVL scaling, and quality adjustments">
        {/* Liquidity component diagram — desktop: 3×2 grid */}
        <div className="hidden md:flex flex-col items-center gap-3">
          <div className="grid grid-cols-5 gap-3 w-full">
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">TVL Depth</p>
              <p className="text-xs text-muted-foreground mt-0.5">35%</p>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Volume Activity</p>
              <p className="text-xs text-muted-foreground mt-0.5">20%</p>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Pool Quality</p>
              <p className="text-xs text-muted-foreground mt-0.5">22.5%</p>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Durability</p>
              <p className="text-xs text-muted-foreground mt-0.5">15%</p>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium">Pair Diversity</p>
              <p className="text-xs text-muted-foreground mt-0.5">7.5%</p>
            </div>
          </div>
          <div className="text-muted-foreground text-xl font-bold">&darr;</div>
          <div className="rounded-lg border p-3 text-center w-64">
            <p className="text-foreground font-medium">Liquidity Score</p>
            <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
          </div>
        </div>

        {/* Liquidity component diagram — mobile: 2-col grid */}
        <div className="flex flex-col items-center gap-3 md:hidden">
          <div className="grid grid-cols-2 gap-2 w-full">
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium text-xs">TVL Depth</p>
              <p className="text-xs text-muted-foreground">35%</p>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium text-xs">Vol. Activity</p>
              <p className="text-xs text-muted-foreground">20%</p>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium text-xs">Pool Quality</p>
              <p className="text-xs text-muted-foreground">22.5%</p>
            </div>
            <div className="rounded-lg border p-3 text-center">
              <p className="text-foreground font-medium text-xs">Durability</p>
              <p className="text-xs text-muted-foreground">15%</p>
            </div>
            <div className="rounded-lg border p-3 text-center col-span-2">
              <p className="text-foreground font-medium text-xs">Pair Diversity</p>
              <p className="text-xs text-muted-foreground">7.5%</p>
            </div>
          </div>
          <div className="text-muted-foreground text-xl font-bold">&darr;</div>
          <div className="w-full rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Liquidity Score</p>
            <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
          </div>
        </div>

        {/* Components */}
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Components</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                    Component
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium text-foreground">
                    Weight
                  </th>
                  <th scope="col" className="py-2 font-medium text-foreground">
                    How it works
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                <tr className="hover:bg-muted/40 transition-colors">
                  <td className="py-2 pr-4 text-foreground">TVL Depth</td>
                  <td className="py-2 pr-4">35%</td>
                  <td className="py-2">
                    Log-scale effective TVL (quality-adjusted, metapool-deduped): $100K&rarr;20, $1M&rarr;40,
                    $10M&rarr;60, $100M&rarr;80, $1B+&rarr;100
                  </td>
                </tr>
                <tr className="hover:bg-muted/40 transition-colors">
                  <td className="py-2 pr-4 text-foreground">Volume Activity</td>
                  <td className="py-2 pr-4">20%</td>
                  <td className="py-2">
                    Log-scale V/T ratio: 33.3&times;log10(vtRatio/0.005). ~0.5%&rarr;13, ~5%&rarr;56, ~50%&rarr;100
                  </td>
                </tr>
                <tr className="hover:bg-muted/40 transition-colors">
                  <td className="py-2 pr-4 text-foreground">Pool Quality</td>
                  <td className="py-2 pr-4">22.5%</td>
                  <td className="py-2">
                    Quality-adjusted TVL using pool mechanism multiplier &times; balance health &times; pair quality.
                    Curve StableSwap (A&ge;500) = 1.0&times;, Uni V3 and Pancake/Slipstream 1bp pools = 1.1&times;,
                    Meteora and other concentrated-liquidity direct sources = 0.85&times;, and generic AMM = 0.3&times;
                  </td>
                </tr>
                <tr className="hover:bg-muted/40 transition-colors">
                  <td className="py-2 pr-4 text-foreground">Durability</td>
                  <td className="py-2 pr-4">15%</td>
                  <td className="py-2">
                    TVL stability (35%), volume consistency (25%), pool maturity (25%), organic fee fraction with sqrt
                    curve (15%)
                  </td>
                </tr>
                <tr className="hover:bg-muted/40 transition-colors">
                  <td className="py-2 pr-4 text-foreground">Pair Diversity</td>
                  <td className="py-2 pr-4">7.5%</td>
                  <td className="py-2">Pool count with diminishing returns: min(100, poolCount &times; 5)</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Quality multipliers */}
        <div className="space-y-2">
          <h3 className="text-foreground font-medium">Pool Quality Adjustments</h3>
          <ul className="list-disc list-inside space-y-1">
            <li>
              <span className="text-foreground">Balance health</span> &mdash; continuous ratio (not binary threshold):
              pools with imbalanced reserves score lower
            </li>
            <li>
              <span className="text-foreground">Pair quality</span> &mdash; co-token scored by Pharos governance
              classification (CeFi&rarr;1.0, DeFi&rarr;0.9, CeFi-Dep&rarr;0.8) plus static map for volatile assets
              (WETH&rarr;0.65, WBTC&rarr;0.6)
            </li>
            <li>
              <span className="text-foreground">Metapool dedup</span> &mdash; uses TVL excluding base pool to prevent
              double-counting across Curve metapools
            </li>
            <li>
              <span className="text-foreground">Retained-pool recomputation</span> &mdash; HHI, depth, volume, and
              balance/organic/durability inputs are all recomputed from the same retained pool set before the UI
              truncates to the top 10 displayed pools
            </li>
          </ul>
        </div>
      </MethodologyDetails>
    </MethodologySectionShell>
  );
}
