import {
  DiagramArrow,
  DiagramReturnArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

const ACCENT = "oklch(0.75 0.13 212)";

export function CdpDiagram({ symbol }: { symbol: string }) {
  const steps = [
    { label: "Crypto collateral", subtitle: "overcollateralized" },
    { label: "Vault / PSM", subtitle: "mint debt vs collateral" },
    { label: `${symbol} minted`, subtitle: "liquidates below ratio" },
  ];

  return (
    <MechanismDiagramShell
      ariaLabel={`Users overcollateralize crypto in a vault to mint ${symbol} as debt; the position is liquidated if collateral falls below the safety ratio.`}
      description={`Users deposit crypto collateral worth more than the debt they want to issue; a vault or peg-stability module mints ${symbol} as debt against the collateral; the position is liquidated if the collateral value falls below the configured safety ratio.`}
      desktopHeight={155}
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
        label={steps[1].label}
        subtitle={steps[1].subtitle}
        stepNumber={2}
        accentColor={ACCENT}
      />
      <DiagramArrow x={350} />
      <DiagramStep
        x={400}
        label={steps[2].label}
        subtitle={steps[2].subtitle}
        width={200}
        stepNumber={3}
        accentColor={ACCENT}
      />
      <DiagramReturnArrow
        fromX={500}
        toX={75}
        topY={90}
        peakY={140}
        label="or liquidated"
        tone="danger"
        dashed
      />
    </MechanismDiagramShell>
  );
}
