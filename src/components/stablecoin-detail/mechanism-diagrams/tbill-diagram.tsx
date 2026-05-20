import type { MechanismDiagramStep } from "./primitives";
import {
  DiagramArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

const ACCENT = "var(--mechanism-tbill)";

const TBILL_STRESS_FOOTNOTE =
  "stress: instant-redemption cap / USDC rail constraint (OUSG)";

interface TbillDiagramProps {
  symbol: string;
  steps?: ReadonlyArray<{ label?: string; subtitle?: string }>;
  stressFootnote?: string;
}

export function TbillDiagram({
  symbol,
  steps: overrideSteps,
  stressFootnote = TBILL_STRESS_FOOTNOTE,
}: TbillDiagramProps) {
  const defaults = [
    { label: "Investor cash", subtitle: "subscribed via fund" },
    { label: "T-Bills + Repos", subtitle: "short-duration RWA" },
    { label: `${symbol} units`, subtitle: "NAV accrues daily" },
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

  return (
    <MechanismDiagramShell
      ariaLabel={`Investor cash funds a short-duration Treasury portfolio; ${symbol} units accrue NAV daily.`}
      description={`Investors subscribe cash into a regulated fund; the fund deploys into short-duration T-Bills and repurchase agreements; ${symbol} units represent fund shares whose NAV accrues daily from the underlying yield.`}
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
    </MechanismDiagramShell>
  );
}
