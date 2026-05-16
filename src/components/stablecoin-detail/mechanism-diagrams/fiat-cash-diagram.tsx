import { DiagramArrow, DiagramStep, MechanismDiagramShell } from "./primitives";

export function FiatCashDiagram({ symbol }: { symbol: string }) {
  const steps = [
    { label: "User USD", subtitle: "wire / ACH" },
    { label: "Issuer reserves", subtitle: "custodied 1:1" },
    { label: `${symbol} minted`, subtitle: "redeem any time" },
  ];

  return (
    <MechanismDiagramShell
      ariaLabel={`${symbol} mechanism: user dollars in, custodied 1:1, redeemable on demand`}
      description={`Users send USD via wire or ACH to the issuer; the issuer custodies the dollars in cash, repos, and short-term Treasuries; the issuer mints ${symbol} 1:1 and lets holders redeem at any time.`}
      steps={steps}
    >
      <DiagramStep x={0} label={steps[0].label} subtitle={steps[0].subtitle} />
      <DiagramArrow x={150} />
      <DiagramStep x={200} label={steps[1].label} subtitle={steps[1].subtitle} />
      <DiagramArrow x={350} />
      <DiagramStep
        x={400}
        label={steps[2].label}
        subtitle={steps[2].subtitle}
        width={200}
      />
    </MechanismDiagramShell>
  );
}
