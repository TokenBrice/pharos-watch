import {
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";

export const CONTENT_MARKDOWN = `## Contagion Stress Test

The contagion stress test models how failure in one stablecoin can propagate through collateral, wrapper, and mechanism dependencies. It asks which assets would inherit stress if a major stablecoin, reserve asset, or shared mechanism became impaired.

Dependency weights are curated from explicit metadata, reserve slices, wrapper relationships, and known mechanism links. The model distinguishes direct collateral exposure from looser operational dependency so a small wrapper link does not receive the same treatment as a majority reserve dependency.

The result is used in report cards, comparison context, and systemic-risk views to identify hidden concentration that is not visible from market capitalization alone.
`;

export function ContagionStressTestMethodologySection() {
  return (
          <MethodologySectionShell
            id="contagion-stress-test-methodology"
            title="Contagion Stress Test"
            versionLabel="v1.0"
            accentClassName="border-l-emerald-500"
            badgeClassName="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
          >
              <p>
                The stress test simulates dependency failures to reveal systemic concentration risk across the stablecoin
                ecosystem.
              </p>
              <p className="text-xs text-muted-foreground">
                See also:{" "}
                <a href="#safety-scores-methodology" className="text-foreground/70 underline underline-offset-2 hover:text-foreground transition-colors">Safety Scores</a>
              </p>
              <MethodologyFacts
                facts={[
                  { label: "Simulation action", value: "Force one coin to grade D" },
                  { label: "Propagation channel", value: "Dependency channel only" },
                  { label: "Primary output", value: "Affected coins + supply at risk" },
                ]}
              />
              <div className="space-y-2">
                <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
                <MethodologyFacts
                  facts={[
                    { label: "Minimum data", value: "Target coin must have dependents and mapped dependency weights" },
                    { label: "Required sources", value: "Current report-card scores plus dependency map inputs" },
                    {
                      label: "Failure behavior",
                      value:
                        "Only direct dependency-risk channel is recomputed (no peg/liquidity/confidence feedback loops)",
                    },
                  ]}
                />
              </div>
              <WorkedExample summary="Worked example (verified against scoreDependencyRisk path used by stress test)">
                <p className="font-mono">
                  Override upstream score to 40; dependent coin has 60% exposure and decentralized self-backed score 90
                </p>
                <p className="font-mono">blended=0.6*40+0.4*90=60; weak-upstream penalty (score&lt;75) applies -10</p>
                <p className="font-mono">dependencyRisk score=50</p>
                <p>
                  Result:{" "}
                  <span className="text-foreground">
                    Dependency dimension falls to 50 before overall grade recomputation
                  </span>
                  .
                </p>
              </WorkedExample>

              <MethodologyDetails summary="Technical details: simulation pipeline, scoreboard logic, and limitations">
                {/* Stress test pipeline diagram — desktop: horizontal */}
                <div className="hidden md:grid grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-4 items-start">
                  <div className="rounded-lg border p-3 text-center self-center">
                    <p className="text-foreground font-medium">Select Target</p>
                    <p className="text-xs text-muted-foreground mt-0.5">pick a coin</p>
                  </div>
                  <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
                  <div className="rounded-lg border p-3 text-center self-center">
                    <p className="text-foreground font-medium">Override to D</p>
                    <p className="text-xs text-muted-foreground mt-0.5">force downgrade</p>
                  </div>
                  <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
                  <div className="rounded-lg border p-3 text-center self-center">
                    <p className="text-foreground font-medium">Recompute Dep. Risk</p>
                    <p className="text-xs text-muted-foreground mt-0.5">cascade upstream</p>
                  </div>
                  <div className="flex items-center self-center text-muted-foreground text-xl font-bold">&rarr;</div>
                  <div className="rounded-lg border p-3 text-center self-center">
                    <p className="text-foreground font-medium">Impact Report</p>
                    <p className="text-xs text-muted-foreground mt-0.5">coins &amp; $ at risk</p>
                  </div>
                </div>

                {/* Stress test pipeline diagram — mobile: vertical */}
                <div className="flex flex-col items-center gap-3 md:hidden">
                  <div className="w-full rounded-lg border p-3 text-center">
                    <p className="text-foreground font-medium">Select Target</p>
                    <p className="text-xs text-muted-foreground mt-0.5">pick a coin</p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="w-full rounded-lg border p-3 text-center">
                    <p className="text-foreground font-medium">Override to D</p>
                    <p className="text-xs text-muted-foreground mt-0.5">force downgrade</p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="w-full rounded-lg border p-3 text-center">
                    <p className="text-foreground font-medium">Recompute Dep. Risk</p>
                    <p className="text-xs text-muted-foreground mt-0.5">cascade upstream</p>
                  </div>
                  <div className="text-muted-foreground text-xl font-bold">&darr;</div>
                  <div className="w-full rounded-lg border p-3 text-center">
                    <p className="text-foreground font-medium">Impact Report</p>
                    <p className="text-xs text-muted-foreground mt-0.5">coins &amp; $ at risk</p>
                  </div>
                </div>

                {/* Systemic Risk Scoreboard */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Systemic Risk Scoreboard</h3>
                  <p>
                    On page load, the scoreboard pre-computes the five most damaging single-coin failure scenarios. For each
                    targetable coin (one that has dependents), it simulates a downgrade to D, counts the number of affected
                    coins, and sums their market cap as &ldquo;supply at risk.&rdquo; Results are sorted by supply at risk
                    descending.
                  </p>
                </div>

                {/* Stress Test */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Stress Test</h3>
                  <p>
                    The interactive stress test overrides a target coin&apos;s overall score, then recomputes the Dependency
                    Risk dimension for every coin that lists that target as an upstream dependency. This models the direct
                    dependency channel only.
                  </p>
                  <p>
                    In reality, a major stablecoin failure would also impact peg stability, liquidity, and market confidence
                    simultaneously &mdash; the stress test captures only the mechanical dependency impact.
                  </p>
                </div>

                {/* Limitations */}
                <div className="space-y-2">
                  <h3 className="text-foreground font-medium">Limitations</h3>
                  <ul className="list-disc list-inside space-y-1">
                    <li>Collateral weights are researched estimates that may not reflect real-time ratios</li>
                    <li>The stress test models only the dependency risk channel, not second-order market effects</li>
                  </ul>
                </div>
              </MethodologyDetails>
          </MethodologySectionShell>
  );
}
