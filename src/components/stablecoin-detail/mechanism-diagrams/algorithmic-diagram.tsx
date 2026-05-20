import type { MechanismDiagramStep } from "./primitives";
import {
  DiagramArrow,
  DiagramReturnArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

const ACCENT = "var(--mechanism-algorithmic)";

export const ALGORITHMIC_STRESS_FOOTNOTE =
  "stress: reflexive collapse (UST, May 2022)";

interface AlgorithmicDiagramProps {
  symbol: string;
  steps?: ReadonlyArray<{ label?: string; subtitle?: string }>;
  stressFootnote?: string;
}

export function AlgorithmicDiagram({
  symbol,
  steps: overrideSteps,
  stressFootnote = ALGORITHMIC_STRESS_FOOTNOTE,
}: AlgorithmicDiagramProps) {
  const defaults = [
    { label: "Burn governance token", subtitle: "algorithmic mint" },
    { label: "Mint/burn AMO", subtitle: "defends peg via arbitrage" },
    { label: `${symbol} minted`, subtitle: "no 1:1 backing" },
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
    dashedBorder: true,
  }));

  return (
    <MechanismDiagramShell
      ariaLabel={`An algorithmic mint/burn module trades a governance token for ${symbol} to defend the peg; the design has no 1:1 reserve backing.`}
      description={`Users burn a governance token to algorithmically mint ${symbol}; an autonomous mint/burn module defends the peg through arbitrage incentives; the system has no 1:1 reserve backing, so confidence in the governance token is critical.`}
      desktopHeight={155}
      steps={steps}
      stressFootnote={stressFootnote}
    >
      <DiagramStep
        x={0}
        label={steps[0].label}
        subtitle={steps[0].subtitle}
        stepNumber={1}
        accentColor={ACCENT}
        dashedBorder
        tone="danger"
      />
      <DiagramArrow x={150} dashed />
      <DiagramStep
        x={200}
        label={steps[1].label}
        subtitle={steps[1].subtitle}
        stepNumber={2}
        accentColor={ACCENT}
        dashedBorder
        tone="danger"
      />
      <DiagramArrow x={350} dashed />
      <DiagramStep
        x={400}
        label={steps[2].label}
        subtitle={steps[2].subtitle}
        width={200}
        stepNumber={3}
        accentColor={ACCENT}
        dashedBorder
        tone="danger"
      />
      <DiagramReturnArrow
        fromX={500}
        toX={75}
        topY={90}
        peakY={140}
        label="reflexive collapse"
        tone="danger"
        dashed
        strokeWidth={1.2}
      />
    </MechanismDiagramShell>
  );
}
