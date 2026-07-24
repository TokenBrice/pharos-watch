import {
  METHODOLOGY_LINK_CLASS,
  MethodologyDetails,
  MethodologyFacts,
  WorkedExample,
} from "../../methodology-shared";
import { SafetyScoreCalculator } from "@/components/methodology/safety-score-calculator";
import { ReserveRelatedSignalsMethodologyCopy } from "../core-sections-fragments";

export function SafetyScoresOverview() {
  return (
    <>
      <p>
        Pharos synthesizes multiple data signals into a single transparent grade per stablecoin. The overall score
        is computed in two steps: first, a weighted average of four base dimensions (exit liquidity, resilience,
        decentralization, dependency risk), then a peg stability multiplier that penalizes coins with poor pegs
        while barely affecting well-pegged ones. The exit-liquidity dimension blends raw DEX liquidity with
        redemption-backstop quality only when the route has usable current evidence. Reviewer-gated wrapper capacity
        can come from same-run withdrawable strategy or Stability Pool balances, or an exact cross-chain route whose
        endpoints and executable inventory are validated together, rather than idle underlying alone;
        reviewed opaque fees can preserve capacity evidence for bounded downstream analysis but do not make the
        current redemption route score-eligible without a numeric cost bound. Reserve data is a separate
        resilience input: live reserve sync can improve collateral quality only when the latest snapshot is fresh,
        independent, clean, and score-grade. When some base dimensions lack data (NR), their weight is redistributed proportionally among rated ones. Active depeg caps use the open event&apos;s peak deviation, while the peg
        dimension itself remains a direct pegScore passthrough.
      </p>
      <p className="text-xs text-muted-foreground">
        See also:{" "}
        <a href="#pegscore-dews-methodology" className={METHODOLOGY_LINK_CLASS}>PegScore + DEWS</a>
        {" · "}
        <a href="#liquidity-methodology" className={METHODOLOGY_LINK_CLASS}>Liquidity Score</a>
        {" · "}
        <a href="#infrastructure-methodology" className={METHODOLOGY_LINK_CLASS}>Infrastructure</a>
      </p>
      <MethodologyFacts
        facts={[
          { label: "Model shape", value: "4 dimensions + peg multiplier" },
          { label: "Grade output", value: "A+ to F, with NR" },
          { label: "Key caveat", value: "No exit signal = 10% penalty" },
        ]}
      />
      <div className="space-y-2">
        <h3 className="text-foreground font-medium">Preconditions &amp; Failure Modes</h3>
        <MethodologyFacts
          facts={[
            { label: "Minimum data", value: "At least 2 rated non-peg dimensions" },
            { label: "Required sources", value: "Peg summary, DEX liquidity/redemption data, and dependency/metadata inputs" },
            {
              label: "Failure behavior",
              value: "NR if peg is missing on non-NAV coins; no-liquidity penalty when both DEX and redemption evidence are unavailable; live reserve adapters stay detail-visible when they are stale, degraded, or proof-only",
            },
          ]}
        />
      </div>
      <ReserveRelatedSignalsMethodologyCopy />
      <WorkedExample summary="Worked example (verified against computeOverallGrade)">
        <p className="pharos-numeric">Inputs: DEX 30, Redemption 88, Exit 91, Res 70, Decen 60, Dep 75, Peg 92</p>
        <p className="pharos-numeric">base=(91*0.30+70*0.20+60*0.15+75*0.25)/0.90=76.72</p>
        <p className="pharos-numeric">final=round(base*(92/100)^0.40)=round(76.72*0.9672)=74</p>
        <p>
          Result: <span className="text-foreground">Score 74 (grade B)</span>.
        </p>
      </WorkedExample>

      <MethodologyDetails summary="Interactive calculator: explore how weights and thresholds shape the grade">
        <SafetyScoreCalculator />
      </MethodologyDetails>
    </>
  );
}
