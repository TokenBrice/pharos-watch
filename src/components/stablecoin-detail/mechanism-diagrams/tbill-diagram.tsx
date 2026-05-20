import {
  DiagramArrow,
  DiagramLoopArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

const ACCENT = "oklch(0.65 0.21 295)";

export function TbillDiagram({ symbol }: { symbol: string }) {
  const steps = [
    { label: "Investor cash", subtitle: "subscribed via fund" },
    { label: "T-Bills + Repos", subtitle: "short-duration RWA" },
    { label: `${symbol} units`, subtitle: "NAV accrues daily" },
  ];

  return (
    <MechanismDiagramShell
      ariaLabel={`Investor cash funds a short-duration Treasury portfolio; ${symbol} units accrue NAV daily.`}
      description={`Investors subscribe cash into a regulated fund; the fund deploys into short-duration T-Bills and repurchase agreements; ${symbol} units represent fund shares whose NAV accrues daily from the underlying yield.`}
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
      <DiagramLoopArrow
        fromX={350}
        toX={400}
        baseY={30}
        peakY={6}
        label="NAV accrues"
        labelY={9}
      />
    </MechanismDiagramShell>
  );
}
