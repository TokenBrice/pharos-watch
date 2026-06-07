import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";

export function SafetyScoresScoringDetails() {
  return (
    <>
      <div className="hidden md:flex flex-col items-center gap-3">
        <div className="grid grid-cols-4 gap-3 w-full">
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Exit Liquidity</p>
            <p className="text-xs text-muted-foreground mt-0.5">30%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Resilience</p>
            <p className="text-xs text-muted-foreground mt-0.5">20%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Decentralization</p>
            <p className="text-xs text-muted-foreground mt-0.5">15%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium">Dependency Risk</p>
            <p className="text-xs text-muted-foreground mt-0.5">25%</p>
          </div>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="rounded-lg border p-3 text-center w-64">
          <p className="text-foreground font-medium">Weighted Average</p>
          <p className="text-xs text-muted-foreground mt-0.5">base score</p>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="rounded-lg border p-3 text-center w-64">
          <p className="text-foreground font-medium">&times; Peg Multiplier</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            (pegScore / 100)<sup>0.40</sup>
          </p>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="rounded-lg border border-amber-500/40 p-3 text-center w-64">
          <p className="text-foreground font-medium">&times; No-Liquidity Penalty</p>
          <p className="text-xs text-muted-foreground mt-0.5">0.9&times; if no DEX or redemption signal</p>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="rounded-lg border p-3 text-center w-64">
          <p className="text-foreground font-medium">Final Grade</p>
          <p className="text-xs text-muted-foreground mt-0.5">A+ through F</p>
        </div>
      </div>

      <div className="flex flex-col items-center gap-3 md:hidden">
        <div className="grid grid-cols-2 gap-2 w-full">
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium text-xs">Exit Liquidity</p>
            <p className="text-xs text-muted-foreground">30%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium text-xs">Resilience</p>
            <p className="text-xs text-muted-foreground">20%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium text-xs">Decentralization</p>
            <p className="text-xs text-muted-foreground">15%</p>
          </div>
          <div className="rounded-lg border p-3 text-center">
            <p className="text-foreground font-medium text-xs">Dep. Risk</p>
            <p className="text-xs text-muted-foreground">25%</p>
          </div>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="w-full rounded-lg border p-3 text-center">
          <p className="text-foreground font-medium">Weighted Average</p>
          <p className="text-xs text-muted-foreground mt-0.5">base score</p>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="w-full rounded-lg border p-3 text-center">
          <p className="text-foreground font-medium">&times; Peg Multiplier</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            (pegScore / 100)<sup>0.40</sup>
          </p>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="w-full rounded-lg border border-amber-500/40 p-3 text-center">
          <p className="text-foreground font-medium">&times; No-Liquidity Penalty</p>
          <p className="text-xs text-muted-foreground mt-0.5">0.9&times; if no DEX or redemption signal</p>
        </div>
        <div className="text-muted-foreground text-xl font-bold">&darr;</div>
        <div className="w-full rounded-lg border p-3 text-center">
          <p className="text-foreground font-medium">Final Grade</p>
          <p className="text-xs text-muted-foreground mt-0.5">A+ through F</p>
        </div>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Base Dimensions (weighted average)</h3>
        <TableFrame
          chrome="content"
          density="compact"
          tableId="methodology-safety-base-dimensions"
          testId="methodology-safety-base-dimensions-table"
          viewportProps={{ mobileScrollHint: false }}
        >
          <TableHeader>
            <TableRow className="text-left">
              <TableHead scope="col" className="py-2 pr-4 text-foreground">
                Dimension
              </TableHead>
              <TableHead scope="col" className="py-2 pr-4 text-foreground">
                Weight
              </TableHead>
              <TableHead scope="col" className="py-2 pr-4 text-foreground">
                Source
              </TableHead>
              <TableHead scope="col" className="py-2 text-foreground">
                Description
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="py-2 pr-4 text-foreground">Exit Liquidity</TableCell>
              <TableCell className="py-2 pr-4">30%</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">DEX liquidity + redemption backstop</TableCell>
              <TableCell className="py-2 whitespace-normal">
                Best-path model: exit quality = best available path (DEX or redemption) + diversification bonus for
                having both
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-2 pr-4 text-foreground">Resilience</TableCell>
              <TableCell className="py-2 pr-4">20%</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">Collateral, custody</TableCell>
              <TableCell className="py-2 whitespace-normal">2-factor solvency measure; blacklist capability reported descriptively only</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-2 pr-4 text-foreground">Decentralization</TableCell>
              <TableCell className="py-2 pr-4">15%</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">Governance type, chain risk</TableCell>
              <TableCell className="py-2 whitespace-normal">Governance structure with chain-risk penalty</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-2 pr-4 text-foreground">Dependency Risk</TableCell>
              <TableCell className="py-2 pr-4">25%</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">Upstream grades, collateral weights</TableCell>
              <TableCell className="py-2 whitespace-normal">Inherited risk from upstream stablecoins, weighted by exposure</TableCell>
            </TableRow>
          </TableBody>
        </TableFrame>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Redemption Backstop and Effective Exit</h3>
        <p>
          The standalone Liquidity Score remains a pure DEX market-depth metric. Safety Scores use an
          <span className="text-foreground font-medium"> effective exit score</span> for the Liquidity dimension, built
          on a best-path model: exit quality equals the best available exit path after redemption is adjusted for
          current executable capacity and route confidence.
        </p>
        <p className="pharos-numeric">modeledExitUsd = min(max(supplyUsd &times; 0.05, 100000), 25000000)</p>
        <p className="pharos-numeric">adjustedRedemption = redemption &times; capacityFactor &times; confidenceFactor</p>
        <p className="pharos-numeric">effectiveExit = round(min(100, max(dex, adjustedRedemption) + independentBonus))</p>
        <p>
          <code className="text-xs">capacityFactor</code> is capped at 1.0 from current executable capacity divided by
          the modeled exit size. Confidence factors are 1.0 for high-confidence routes, 0.75 for medium-confidence
          routes, and 0.35 for low-confidence routes. The 10% secondary-path bonus is only applied when the redemption
          rail is independent from the DEX liquidity path, such as an issuer primary-market rail.
        </p>
        <p>
          If only DEX liquidity exists, it is used directly. Eligible immediate, live, or queue-style redemption can
          stand alone when DEX liquidity is absent, with route family caps and component scoring as guardrails.
          Documented offchain issuer routes with eventual-only capacity do not replace missing DEX liquidity; they can
          only add the independent primary-market bonus when DEX liquidity already exists.
        </p>
        <p>
          Redemption backstops are scored across access, settlement, execution certainty, capacity, output-asset
          quality, and cost. Low-confidence redemption routes stay visible on the site but do not uplift the Safety
          Score liquidity dimension. Documented offchain issuer exits with eventual-only capacity can add a
          primary-market bonus only when DEX liquidity already exists; they do not replace missing DEX liquidity. Severe
          active depegs also disable static or non-live-direct redemption uplift unless current live-open redemption
          evidence exists. Last-known DEX inputs still feed effective-exit scoring when the liquidity cron is stale,
          with staleness surfaced through <code className="text-xs">liquidityStale</code> /{" "}
          <code className="text-xs">inputFreshness.dexLiquidity.stale</code>. Materially stale or missing redemption
          snapshots are suppressed from Safety Score liquidity; normal 4-hourly redemption-sync lag remains inside the
          scoring freshness runway. Unknown route status remains low confidence for proxy-only or weaker evidence, but
          reviewed documented-bound routes can retain medium confidence when the rest of the evidence gates pass.
          Redemption metadata emitted by a live reserve adapter ages out with the reserve snapshot; if it is stale or
          degraded, the route stays visible but does not score as current capacity.
        </p>
        <p>
          Current route coverage includes reviewed issuer rails, on-chain collateral redemptions, protocol NAV wrappers,
          and queued vault exits; newly reviewed wrappers and Nest-style vaults follow the same route-family caps and
          confidence gates as older configured routes.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Peg Stability Multiplier</h3>
        <p>
          After computing the base score, peg stability is applied as a power-curve multiplier:
          final&nbsp;=&nbsp;base&nbsp;&times;&nbsp;(pegScore&nbsp;/&nbsp;100)<sup>0.40</sup>. Coins with strong pegs
          (90+) are barely affected (~4% penalty), while coins with broken pegs are sharply penalized (e.g.
          pegScore&nbsp;10 &rarr; 60% penalty). Pure NAV fund-share tokens with no configured peg reference keep
          pegScore&nbsp;=&nbsp;NR and receive multiplier&nbsp;1.0, while configured NAV wrappers can inherit peg risk
          from a referenced base stablecoin. The peg dimension passes through the computed peg score directly; severe
          active depegs are hard-capped after the multiplier using the open event&apos;s peak deviation:
          &ge;&nbsp;2500&nbsp;bps (25%+) caps the overall score at F, &ge;&nbsp;1000&nbsp;bps (10%+) caps at D.
        </p>
      </div>

      <div className="space-y-2">
        <h3 className="text-foreground font-medium">No-Liquidity-Data Penalty</h3>
        <p>
          A further 0.9&times; multiplier is applied when a coin has no exit-liquidity signal at all — neither DEX
          liquidity nor redemption-backstop coverage. Weights are redistributed across available dimensions; this
          0.9&times; multiplier is then applied to the final score to correct for the missing liquidity data by applying
          a flat 10% penalty.
        </p>
      </div>
    </>
  );
}
