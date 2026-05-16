import { DiagramArrow, DiagramStep, MechanismDiagramShell } from "./primitives";

const ACCENT = "oklch(0.7 0.18 15)";

export function AlgorithmicDiagram({ symbol }: { symbol: string }) {
  const steps = [
    { label: "Burn governance token", subtitle: "algorithmic mint" },
    { label: "Mint/burn AMO", subtitle: "defends peg via arbitrage" },
    { label: `${symbol} minted`, subtitle: "no 1:1 backing" },
  ];

  return (
    <MechanismDiagramShell
      ariaLabel={`An algorithmic mint/burn module trades a governance token for ${symbol} to defend the peg; the design has no 1:1 reserve backing.`}
      description={`Users burn a governance token to algorithmically mint ${symbol}; an autonomous mint/burn module defends the peg through arbitrage incentives; the system has no 1:1 reserve backing, so confidence in the governance token is critical.`}
      desktopHeight={132}
      steps={steps}
    >
      <DiagramStep
        x={0}
        label={steps[0].label}
        subtitle={steps[0].subtitle}
        stepNumber={1}
        accentColor={ACCENT}
        dashedBorder
      />
      <DiagramArrow x={150} dashed />
      <DiagramStep
        x={200}
        label={steps[1].label}
        subtitle={steps[1].subtitle}
        callout="no reserves"
        stepNumber={2}
        accentColor={ACCENT}
        dashedBorder
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
      />
    </MechanismDiagramShell>
  );
}
