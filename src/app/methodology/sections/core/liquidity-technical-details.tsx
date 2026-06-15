import { LIQUIDITY_SCORE_WEIGHTS, type LiquidityScoreComponentKey } from "@shared/lib/liquidity-score-weights";
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { MethodologyDetails } from "../../methodology-shared";

const LIQUIDITY_COMPONENT_DETAILS: Record<LiquidityScoreComponentKey, { label: string; shortLabel: string; description: string }> = {
  tvlDepth: {
    label: "TVL Depth",
    shortLabel: "TVL Depth",
    description: "Effective TVL relative to market cap (log-scale): 35xlog10(depthRatio/0.0007). ~0.5%->30, ~1.5%->47, ~6%->67, ~14%->80, ~25%+->90+. Falls back to absolute TVL scale when market cap is unavailable.",
  },
  volumeActivity: {
    label: "Volume Activity",
    shortLabel: "Vol. Activity",
    description: "Log-scale V/T ratio: 38x(log10(vtRatio)+3). ~0.3%->18, ~3.5%->59, ~19%->86, ~32%+->100",
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

function LiquidityComponentCard({
  component,
}: {
  component: (typeof LIQUIDITY_SCORE_WEIGHTS)[number];
}) {
  const detail = LIQUIDITY_COMPONENT_DETAILS[component.key];
  return (
    <div
      className={
        component.key === "pairDiversity"
          ? "col-span-2 md:col-span-1 rounded-lg border p-3 text-center"
          : "rounded-lg border p-3 text-center"
      }
    >
      <p className="text-foreground font-medium text-xs md:text-base">
        <span className="md:hidden">{detail.shortLabel}</span>
        <span className="hidden md:inline">{detail.label}</span>
      </p>
      <p className="text-xs text-muted-foreground mt-0.5">{component.displayWeight}</p>
    </div>
  );
}

export function LiquidityTechnicalDetails() {
  return (
    <MethodologyDetails summary="Technical details: component weights, TVL scaling, and quality adjustments">
      <div className="flex flex-col items-center gap-3">
        <div className="grid grid-cols-2 gap-2 w-full md:grid-cols-5 md:gap-3">
          {LIQUIDITY_SCORE_WEIGHTS.map((component) => (
            <LiquidityComponentCard key={component.key} component={component} />
          ))}
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="w-full rounded-lg border p-3 text-center md:w-64">
          <p className="text-foreground font-medium">Liquidity Score</p>
          <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Components</h3>
        <TableFrame
          chrome="content"
          density="compact"
          tableId="methodology-liquidity-components"
          testId="methodology-liquidity-components-table"
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableHeader>
            <TableRow className="text-left">
              <TableHead scope="col" className="py-2 pr-4 text-foreground">
                Component
              </TableHead>
              <TableHead scope="col" className="py-2 pr-4 text-foreground">
                Weight
              </TableHead>
              <TableHead scope="col" className="py-2 text-foreground">
                How it works
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {LIQUIDITY_SCORE_WEIGHTS.map((component) => {
              const detail = LIQUIDITY_COMPONENT_DETAILS[component.key];
              return (
                <TableRow key={component.key}>
                  <TableCell className="py-2 pr-4 text-foreground">{detail.label}</TableCell>
                  <TableCell className="py-2 pr-4">{component.displayWeight}</TableCell>
                  <TableCell className="py-2 whitespace-normal">{detail.description}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </TableFrame>
      </div>

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
  );
}
