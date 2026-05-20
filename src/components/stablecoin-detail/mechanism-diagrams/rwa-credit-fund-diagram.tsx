import type { MechanismDiagramStep } from "./primitives";
import {
  DiagramArrow,
  DiagramReturnArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

const ACCENT = "var(--mechanism-rwa-credit-fund)";

export const RWA_CREDIT_FUND_STRESS_FOOTNOTE =
  "stress: NAV markdown / quarterly gate";

interface RwaCreditFundDiagramProps {
  symbol: string;
  steps?: ReadonlyArray<{ label?: string; subtitle?: string }>;
  stressFootnote?: string;
}

export function RwaCreditFundDiagram({
  symbol,
  steps: overrideSteps,
  stressFootnote = RWA_CREDIT_FUND_STRESS_FOOTNOTE,
}: RwaCreditFundDiagramProps) {
  const defaults = [
    { label: "Investor cash", subtitle: "subscribed via fund (KYC)" },
    { label: "Private credit / CLO", subtitle: "credit risk, illiquid" },
    { label: `${symbol} fund-share`, subtitle: "NAV reflects credit losses" },
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
      ariaLabel={`Accredited investor cash funds a private-credit or CLO portfolio; ${symbol} fund-share NAV reflects credit losses with quarterly redemption gates.`}
      description={`Accredited investors subscribe cash into a regulated credit fund; the fund deploys into private credit, CLOs, or structured debt with real default risk and limited liquidity; ${symbol} represents a fund share whose NAV reflects credit performance, with redemptions typically allowed only at quarterly windows.`}
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
        label="quarterly redemption"
        strokeWidth={1.2}
        dashed
      />
    </MechanismDiagramShell>
  );
}
