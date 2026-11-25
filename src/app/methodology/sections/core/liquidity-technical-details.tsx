import {
  DEX_DEAD_POOL_TVL_MIN_USD,
  DEX_VOLUME_COVERAGE_MIN,
  DEX_VOLUME_OBSERVATION_MAX_AGE_SEC,
} from "@shared/lib/dex-volume-availability";
import { LIQUIDITY_SCORE_WEIGHTS, type LiquidityScoreComponentKey } from "@shared/lib/liquidity-score-weights";
import { ContentTable } from "@/components/table";
import { MethodologyDetails, MethodologyDiagramFlow } from "../../methodology-shared";

const LIQUIDITY_COMPONENT_DETAILS: Record<LiquidityScoreComponentKey, { label: string; shortLabel: string; description: string }> = {
  tvlDepth: {
    label: "TVL Depth",
    shortLabel: "TVL Depth",
    description: "Effective TVL relative to market cap (log-scale): 35xlog10(depthRatio/0.0007). ~0.5%->30, ~1.5%->47, ~6%->67, ~14%->80, ~25%+->90+. Falls back to absolute TVL scale when market cap is unavailable.",
  },
  volumeActivity: {
    label: "Volume Activity",
    shortLabel: "Vol. Activity",
    description: `Log-scale V/T ratio: 38x(log10(vtRatio)+3). ~0.3%->18, ~3.5%->59, ~19%->86, ~43%+->100. Uses admitted pools only (24h volume observed within ${DEX_VOLUME_OBSERVATION_MAX_AGE_SEC / 3600}h): admitted volume / admitted TVL. Rated when admitted pools cover at least ${Math.round(DEX_VOLUME_COVERAGE_MIN * 100)}% of retained TVL; below that it is unavailable and the Liquidity Score is NR, with no reweighting or estimate for unobserved pools. A measured zero still scores 0.`,
  },
  poolQuality: {
    label: "Pool Quality",
    shortLabel: "Pool Quality",
    description: "Venue quality retention: qualityAdjustedTvl/totalTvl, rescaled from the realistic 15-80% range to 0-100. Measures mechanism multiplier x balance health; pair quality is captured in TVL Depth via effectiveTvl.",
  },
  durability: {
    label: "Durability",
    shortLabel: "Durability",
    description: "TVL stability (35%), volume consistency (25%), pool maturity (25%), organic fee fraction with sqrt curve (15%)",
  },
  pairDiversity: {
    label: "Diversity",
    shortLabel: "Diversity",
    description: "Pool count with diminishing returns: min(100, poolCount x 5)",
  },
};

export function LiquidityTechnicalDetails() {
  return (
    <MethodologyDetails summary="Technical details: component weights, TVL scaling, and quality adjustments">
      <MethodologyDiagramFlow
        inputCols={5}
        inputs={LIQUIDITY_SCORE_WEIGHTS.map((component) => {
          const detail = LIQUIDITY_COMPONENT_DETAILS[component.key];
          return {
            title: detail.label,
            shortTitle: detail.shortLabel,
            subtitle: component.displayWeight,
            itemClassName: component.key === "pairDiversity" ? "col-span-2 md:col-span-1" : undefined,
          };
        })}
        steps={[
          { title: "Liquidity Score", subtitle: <>0&ndash;100</>, emphasis: "output", className: "md:w-64" },
        ]}
      />

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Components</h3>
        <ContentTable
          chrome="embedded"
          tableId="methodology-liquidity-components"
          testId="methodology-liquidity-components-table"
          tableClassName="min-w-[560px]"
          viewportProps={{ mobileScrollHint: "Swipe sideways for more columns" }}
          columns={[
            { id: "component", header: "Component", cellClassName: "text-foreground" },
            { id: "weight", header: "Weight", cellClassName: "pharos-numeric whitespace-nowrap" },
            { id: "description", header: "How it works", cellClassName: "whitespace-normal" },
          ]}
          rows={LIQUIDITY_SCORE_WEIGHTS.map((component) => ({
            id: component.key,
            cells: {
              component: LIQUIDITY_COMPONENT_DETAILS[component.key].label,
              weight: component.displayWeight,
              description: LIQUIDITY_COMPONENT_DETAILS[component.key].description,
            },
          }))}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Pool quality adjustments</h3>
        <ul className="list-disc list-inside space-y-1">
          <li>
            <span className="text-foreground">Balance health</span> &mdash; continuous ratio (not binary threshold),
            read from the tracked coin&rsquo;s side: a pool holding more than its share of the coin scores lower,
            while extra counter-asset is more exit depth and never a penalty
          </li>
          <li>
            <span className="text-foreground">Pair quality</span> &mdash; co-token scored by Pharos governance
            classification (CeFi&rarr;1.0, DeFi&rarr;0.9, CeFi-Dep&rarr;0.8) plus static map for volatile assets
            (WETH&rarr;0.65, WBTC&rarr;0.6); composite Curve LP aliases such as 3Crv inherit the best quality of
            their underlying stablecoin basket
          </li>
          <li>
            <span className="text-foreground">Metapool TVL</span> &mdash; a Curve metapool counts its full TVL,
            including the base-pool LP leg (3Crv, FRAXBP) its coin trades against
          </li>
          <li>
            <span className="text-foreground">Dead-pool floor</span> &mdash; a pool with at least $
            {(DEX_DEAD_POOL_TVL_MIN_USD / 1_000_000).toFixed(0)}M of TVL is dropped from the score and from
            DEX-implied prices when its 24h reading shows zero trades (CoinGecko Onchain reported no buys and no
            sells, on a network where CoinGecko records trades) and its other token is not a tracked stablecoin.
            These are single-sided pools: a few dollars of the stablecoin seed a ~$1 price, and the provider values
            large amounts of an unlisted token at that price. Missing or unverified volume never triggers the floor,
            and a pool counts again as soon as CoinGecko reports a trade in it
          </li>
          <li>
            <span className="text-foreground">Retained-pool recomputation</span> &mdash; HHI, depth, volume, and
            balance/organic/durability inputs are all recomputed from the same retained pool set before the UI
            truncates to the top 10 displayed pools
          </li>
          <li>
            <span className="text-foreground">Global population basis</span> &mdash; headline TVL, protocol and
            chain breakdowns, and volume-coverage TVL denominators use the same retained pools deduplicated
            across coins. External protocol totals gate fallback admission, never rescale trusted raw TVL or
            observed volume. Over-headroom fallback groups are quarantined across physical-pool attributions,
            with excluded counts and raw TVL disclosed separately. Quality-adjusted and effective TVL are
            separate scoring models, not replacements for observed statistics; provider valuations are not guaranteed correct
          </li>
          <li>
            <span className="text-foreground">Measured evidence</span> &mdash; complete finite provider values,
            valid token scales and complete balance legs are required. Unknown balances stay
            unmeasured, while measured zero remains zero. Factory references must be independently current;
            carried pool identity cannot supply a current USD price. Each historical quote ages at assessment,
            and canonical block hashes and fresh non-future per-peg FX bind measured capacity
          </li>
          <li>
            <span className="text-foreground">Measurement epochs</span> &mdash; v6.97 records the changed retained
            population without rewriting history. Paired source stages reject incompatible older admission
            policies; TVL trends do not interpret a policy step as a market withdrawal
          </li>
        </ul>
      </div>
    </MethodologyDetails>
  );
}
