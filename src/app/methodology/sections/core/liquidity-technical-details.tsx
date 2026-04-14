import { MethodologyDetails } from "../../methodology-shared";

export function LiquidityTechnicalDetails() {
  return (
    <MethodologyDetails summary="Technical details: component weights, TVL scaling, and quality adjustments">
      <div className="hidden md:flex flex-col items-center gap-3">
        <div className="grid grid-cols-5 gap-3 w-full">
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">TVL Depth</p>
            <p className="text-xs text-muted-foreground mt-0.5">30%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Volume Activity</p>
            <p className="text-xs text-muted-foreground mt-0.5">20%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Pool Quality</p>
            <p className="text-xs text-muted-foreground mt-0.5">20%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Durability</p>
            <p className="text-xs text-muted-foreground mt-0.5">20%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Diversity</p>
            <p className="text-xs text-muted-foreground mt-0.5">10%</p>
          </div>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="rounded-lg border p-3 text-center w-64">
          <p className="text-foreground font-medium">Liquidity Score</p>
          <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 md:hidden">
        <div className="grid grid-cols-2 gap-2 w-full">
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium text-xs">TVL Depth</p>
            <p className="text-xs text-muted-foreground">30%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium text-xs">Vol. Activity</p>
            <p className="text-xs text-muted-foreground">20%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium text-xs">Pool Quality</p>
            <p className="text-xs text-muted-foreground">20%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium text-xs">Durability</p>
            <p className="text-xs text-muted-foreground">20%</p>
          </div>
          <div className="rounded-lg border p-3 text-center col-span-2">
            <p className="text-foreground font-medium text-xs">Diversity</p>
            <p className="text-xs text-muted-foreground">10%</p>
          </div>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="w-full rounded-lg border p-3 text-center">
          <p className="text-foreground font-medium">Liquidity Score</p>
          <p className="text-xs text-muted-foreground mt-0.5">0&ndash;100</p>
        </div>
      </div>

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
                <td className="py-2 pr-4">30%</td>
                <td className="py-2">
                  Effective TVL relative to market cap (log-scale): 35&times;log10(depthRatio/0.0007). ~0.5%&rarr;30,
                  ~1.5%&rarr;47, ~6%&rarr;67, ~14%&rarr;80, ~25%+&rarr;90+. Falls back to absolute TVL scale when
                  market cap is unavailable.
                </td>
              </tr>
              <tr className="hover:bg-muted/40 transition-colors">
                <td className="py-2 pr-4 text-foreground">Volume Activity</td>
                <td className="py-2 pr-4">20%</td>
                <td className="py-2">
                  Log-scale V/T ratio: 38&times;(log10(vtRatio)+3). ~0.3%&rarr;18, ~3.5%&rarr;59, ~19%&rarr;86,
                  ~32%+&rarr;100
                </td>
              </tr>
              <tr className="hover:bg-muted/40 transition-colors">
                <td className="py-2 pr-4 text-foreground">Pool Quality</td>
                <td className="py-2 pr-4">20%</td>
                <td className="py-2">
                  Venue quality retention: qualityAdjustedTvl/totalTvl, rescaled from the realistic 15&ndash;80% range
                  to 0&ndash;100. Measures mechanism multiplier &times; balance health; pair quality is captured in TVL
                  Depth via effectiveTvl.
                </td>
              </tr>
              <tr className="hover:bg-muted/40 transition-colors">
                <td className="py-2 pr-4 text-foreground">Durability</td>
                <td className="py-2 pr-4">20%</td>
                <td className="py-2">
                  TVL stability (35%), volume consistency (25%), pool maturity (25%), organic fee fraction with sqrt
                  curve (15%)
                </td>
              </tr>
              <tr className="hover:bg-muted/40 transition-colors">
                <td className="py-2 pr-4 text-foreground">Diversity</td>
                <td className="py-2 pr-4">10%</td>
                <td className="py-2">Pool count with diminishing returns: min(100, poolCount &times; 5)</td>
              </tr>
            </tbody>
          </table>
        </div>
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
