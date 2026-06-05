import { ThreeStepMechanismDiagram } from "./three-step-diagram";

const ACCENT = "var(--mechanism-algorithmic)";

const ALGORITHMIC_STRESS_FOOTNOTE =
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
  const defaultSteps = [
    { label: "Burn governance token", subtitle: "algorithmic mint" },
    { label: "Mint/burn AMO", subtitle: "defends peg via arbitrage" },
    { label: `${symbol} minted`, subtitle: "no 1:1 backing" },
  ] as const;

  return (
    <ThreeStepMechanismDiagram
      ariaLabel={`An algorithmic mint/burn module trades a governance token for ${symbol} to defend the peg; the design has no 1:1 reserve backing.`}
      description={`Users burn a governance token to algorithmically mint ${symbol}; an autonomous mint/burn module defends the peg through arbitrage incentives; the system has no 1:1 reserve backing, so confidence in the governance token is critical.`}
      accentColor={ACCENT}
      defaultSteps={defaultSteps}
      overrideSteps={overrideSteps}
      stressFootnote={stressFootnote}
      stepTone="danger"
      dashed
      returnArrow={{
        fromX: 500,
        toX: 75,
        topY: 90,
        peakY: 140,
        label: "reflexive collapse",
        tone: "danger",
        dashed: true,
        strokeWidth: 1.2,
      }}
    />
  );
}
