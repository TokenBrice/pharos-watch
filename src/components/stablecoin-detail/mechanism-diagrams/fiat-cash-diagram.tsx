import type { MechanismDiagramStep } from "./primitives";
import {
  DiagramArrow,
  DiagramReturnArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

const ACCENT = "var(--mechanism-fiat-cash)";

export const FIAT_CASH_STRESS_FOOTNOTE =
  "stress: banking-rail freeze (USDC, Mar 2023)";

interface FiatCashDiagramProps {
  symbol: string;
  steps?: ReadonlyArray<{ label?: string; subtitle?: string }>;
  stressFootnote?: string;
}

export function FiatCashDiagram({
  symbol,
  steps: overrideSteps,
  stressFootnote = FIAT_CASH_STRESS_FOOTNOTE,
}: FiatCashDiagramProps) {
  const defaults = [
    { label: "User USD", subtitle: "wire / ACH" },
    { label: "Issuer reserves", subtitle: "custodied 1:1" },
    { label: `${symbol} minted`, subtitle: "redeem any time" },
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
      ariaLabel={`${symbol} mechanism: user dollars in, custodied 1:1, redeemable on demand`}
      description={`Users send USD via wire or ACH to the issuer; the issuer custodies the dollars in cash, repos, and short-term Treasuries; the issuer mints ${symbol} 1:1 and lets holders redeem at any time.`}
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
        toX={275}
        topY={90}
        peakY={140}
        label="redeem"
        strokeWidth={1.2}
      />
    </MechanismDiagramShell>
  );
}
