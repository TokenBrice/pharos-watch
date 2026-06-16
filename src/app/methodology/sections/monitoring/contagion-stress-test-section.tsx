import { Fragment } from "react";
import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyFacts,
  MethodologySectionShell,
  WorkedExample,
} from "../../methodology-shared";
import { CONTAGION_SECTION_CONTENT } from "../methodology-content";

const STRESS_TEST_STEPS = [
  { title: "Select Target", subtitle: "pick a coin" },
  { title: "Override to D", subtitle: "force downgrade" },
  { title: "Recompute Dep. Risk", subtitle: "cascade upstream" },
  { title: "Impact Report", subtitle: "coins & $ at risk" },
];

export function ContagionStressTestMethodologySection() {
  return (
          <MethodologySectionShell
            id={CONTAGION_SECTION_CONTENT.id}
            title={CONTAGION_SECTION_CONTENT.title}
          >
              <p>
                The stress test simulates dependency failures to reveal systemic concentration risk across the stablecoin
                ecosystem.
              </p>
              <p className="text-xs text-muted-foreground">
                See also:{" "}
                <a href="#safety-scores-methodology" className={METHODOLOGY_LINK_CLASS}>Safety Scores</a>
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
                <p className="pharos-numeric">
                  Override upstream score to 40; dependent coin has 60% exposure and decentralized self-backed score 90
                </p>
                <p className="pharos-numeric">blended=0.6*40+0.4*90=60; weak-upstream penalty (score&lt;75) applies -10</p>
                <p className="pharos-numeric">dependencyRisk score=50</p>
                <p>
                  Result:{" "}
                  <span className="text-foreground">
                    Dependency dimension falls to 50 before overall grade recomputation
                  </span>
                  .
                </p>
              </WorkedExample>

              <MethodologyDetails summary="Technical details: simulation pipeline, scoreboard logic, and limitations">
                {/* Stress test pipeline diagram — mobile: vertical, desktop: horizontal */}
                <div className="flex flex-col items-center gap-3 md:flex-row md:items-center md:gap-4">
                  {STRESS_TEST_STEPS.map((step, index) => (
                    <Fragment key={step.title}>
                      {index > 0 && (
                        <div aria-hidden="true" className="text-muted-foreground text-xl font-bold">
                          <span className="md:hidden">&darr;</span>
                          <span className="hidden md:inline">&rarr;</span>
                        </div>
                      )}
                      <div className="w-full rounded-lg border p-3 text-center md:flex-1">
                        <p className="text-foreground font-medium">{step.title}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">{step.subtitle}</p>
                      </div>
                    </Fragment>
                  ))}
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
