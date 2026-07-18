import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { MethodologyDiagramFlow } from "../../methodology-shared";

export function SafetyScoresScoringDetails() {
  return (
    <>
      <MethodologyDiagramFlow
        inputCols={4}
        inputs={[
          { title: "Exit Liquidity", subtitle: "30%" },
          { title: "Resilience", subtitle: "20%" },
          { title: "Decentralization", subtitle: "15%" },
          { title: "Dependency Risk", shortTitle: "Dep. Risk", subtitle: "25%" },
        ]}
        steps={[
          { title: "Weighted Average", subtitle: "base score", className: "md:w-64" },
          {
            title: <>&times; Peg Multiplier</>,
            subtitle: (
              <>
                (pegScore / 100)<sup>0.40</sup>
              </>
            ),
            className: "md:w-64",
          },
          {
            title: <>&times; No-Liquidity Penalty</>,
            subtitle: <>0.9&times; if no DEX or redemption signal</>,
            className: "md:w-64 border-amber-500/40",
          },
          { title: "Final Grade", subtitle: "A+ through F", className: "md:w-64" },
        ]}
      />

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
              <TableCell className="py-2 whitespace-normal">
                2-factor solvency measure; blacklist capability reported descriptively only
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-2 pr-4 text-foreground">Decentralization</TableCell>
              <TableCell className="py-2 pr-4">15%</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">
                Governance type, chain risk, branch-aware CDP oracle setup, bridge route, mint authority
              </TableCell>
              <TableCell className="py-2 whitespace-normal">
                Governance structure with chain-risk, oracle, bridge-route, and privileged-mint penalties
              </TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="py-2 pr-4 text-foreground">Dependency Risk</TableCell>
              <TableCell className="py-2 pr-4">25%</TableCell>
              <TableCell className="py-2 pr-4 whitespace-normal">Upstream grades, collateral weights</TableCell>
              <TableCell className="py-2 whitespace-normal">
                Inherited risk from upstream stablecoins, weighted by exposure
              </TableCell>
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
        <p>
          Before that blend, the DEX input is bounded by its retained evidence: reserve-based AMM simulation caps at 85,
          generic TVL proxy evidence at 60, synthetic or fallback evidence at 55, and provider-inaccessible-only
          deployment coverage at 45. Older snapshots without these evidence fields and rows explicitly marked legacy
          remain neutral. The public standalone Liquidity Score is not rewritten by this Safety Score policy.
        </p>
        <p className="pharos-numeric">modeledExitUsd = min(max(supplyUsd &times; 0.05, 100000), 25000000)</p>
        <p className="pharos-numeric">
          adjustedRedemption = redemption &times; capacityFactor &times; confidenceFactor
        </p>
        <p className="pharos-numeric">
          effectiveExit = round(min(100, max(dex, adjustedRedemption) + independentBonus))
        </p>
        <p>
          <code className="text-xs">capacityFactor</code> is capped at 1.0 from current executable capacity divided by
          the modeled exit size. Confidence factors are 1.0 for high-confidence routes, 0.75 for medium-confidence
          routes, and 0.35 for low-confidence routes. The 10% secondary-path bonus is only applied when the redemption
          rail is independent from the DEX liquidity path, such as an issuer primary-market rail.
        </p>
        <p>
          Live reserve metadata counts as executable capacity only when it isolates assets immediately available to the
          holder route. Mixed reserve or accounting buckets remain backing context and cannot override a reviewed
          fallback; for example, USDe retains its 0.5% hot-buffer fallback because Ethena&apos;s aggregate Liquid Cash
          category does not isolate route-executable assets.
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
          Same-run live adapter telemetry can also carry token-specific route status and capacity for Liquity-style
          systems, wrappers, PSMs, Yearn V3 strategy-queue exits, and instant-redemption vaults. Redemption metadata
          emitted by a live reserve adapter ages out with the reserve snapshot; if it is stale or degraded, the route
          stays visible but does not score as current capacity.
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
