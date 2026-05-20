import type { MechanismDiagramStep } from "./primitives";
import {
  DiagramArrow,
  DiagramLoopArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

const ACCENT = "var(--mechanism-synthetic-delta-neutral)";

const SYNTHETIC_DELTA_NEUTRAL_STRESS_FOOTNOTE =
  "stress: funding-rate inversion";

interface SyntheticDeltaNeutralDiagramProps {
  symbol: string;
  steps?: ReadonlyArray<{ label?: string; subtitle?: string }>;
  stressFootnote?: string;
}

export function SyntheticDeltaNeutralDiagram({
  symbol,
  steps: overrideSteps,
  stressFootnote = SYNTHETIC_DELTA_NEUTRAL_STRESS_FOOTNOTE,
}: SyntheticDeltaNeutralDiagramProps) {
  const defaults = [
    { label: "Crypto deposit", subtitle: "spot collateral" },
    { label: "Long spot + short perp", subtitle: "delta-neutral hedge" },
    { label: `${symbol} minted`, subtitle: "funding-rate yield" },
  ] as const;

  const merged = defaults.map((d, i) => ({
    label: overrideSteps?.[i]?.label ?? d.label,
    subtitle: overrideSteps?.[i]?.subtitle ?? d.subtitle,
  }));

  const steps: MechanismDiagramStep[] = merged.map((s, i) => ({
    label: s.label,
    subtitle: s.subtitle,
    accentColor: ACCENT,
    stepNumber: i + 1,
  }));

  const step2Callout = overrideSteps?.[1]?.subtitle;

  return (
    <MechanismDiagramShell
      ariaLabel={`Crypto deposited as spot collateral is hedged with equal short perp positions; the funding rate paid by perp longs becomes the yield on ${symbol}.`}
      description={`Users deposit crypto as spot collateral; the protocol opens an equal-size short perpetual futures position to neutralize price exposure; the funding rate paid by perp longs flows to ${symbol} holders as yield.`}
      desktopHeight={step2Callout ? 140 : 120}
      steps={steps}
      stressFootnote={stressFootnote}
    >
      <DiagramStep
        x={0}
        label={steps[0].label}
        subtitle={steps[0].subtitle}
        stepNumber={1}
        accentColor={ACCENT}
      />
      <DiagramArrow x={150} />
      <DiagramStep
        x={200}
        width={150}
        stepNumber={2}
        accentColor={ACCENT}
        callout={step2Callout}
      >
        <polygon
          points="34,20 42,20 38,13"
          fill="var(--severity-healthy)"
        />
        <text
          x={48}
          y={24}
          fontSize={11}
          fontWeight={600}
          fill="currentColor"
        >
          Long spot
        </text>
        <polygon
          points="34,42 42,42 38,49"
          fill="var(--severity-severe)"
        />
        <text
          x={48}
          y={47}
          fontSize={11}
          fontWeight={600}
          fill="currentColor"
        >
          Short perp
        </text>
      </DiagramStep>
      <DiagramArrow x={350} />
      <DiagramStep
        x={400}
        label={steps[2].label}
        subtitle={steps[2].subtitle}
        width={200}
        stepNumber={3}
        accentColor={ACCENT}
      />
      <DiagramLoopArrow
        fromX={275}
        toX={500}
        baseY={30}
        peakY={6}
        label="funding"
        labelY={9}
      />
    </MechanismDiagramShell>
  );
}
