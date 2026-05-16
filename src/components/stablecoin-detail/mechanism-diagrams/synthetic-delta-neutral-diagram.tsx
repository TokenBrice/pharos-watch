import { DiagramArrow, DiagramStep, MechanismDiagramShell } from "./primitives";

const ACCENT = "oklch(0.68 0.13 182)";

export function SyntheticDeltaNeutralDiagram({ symbol }: { symbol: string }) {
  const steps = [
    { label: "Crypto deposit", subtitle: "spot collateral" },
    { label: "Long spot + short perp", subtitle: "delta-neutral hedge" },
    { label: `${symbol} minted`, subtitle: "funding-rate yield" },
  ];

  return (
    <MechanismDiagramShell
      ariaLabel={`Crypto deposited as spot collateral is hedged with equal short perp positions; the funding rate paid by perp longs becomes the yield on ${symbol}.`}
      description={`Users deposit crypto as spot collateral; the protocol opens an equal-size short perpetual futures position to neutralize price exposure; the funding rate paid by perp longs flows to ${symbol} holders as yield.`}
      steps={steps}
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
    </MechanismDiagramShell>
  );
}
