import {
  LIQUIDITY_METHODOLOGY_CHANGELOG_PATH,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/liquidity-score-version";
import { MethodologyFacts, MethodologySectionShell, WorkedExample } from "../../methodology-shared";
import { LiquidityTechnicalDetails } from "./liquidity-technical-details";

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

      <LiquidityTechnicalDetails />
    </MethodologySectionShell>
  );
}
