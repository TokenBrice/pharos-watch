import type { MechanismDiagramStep } from "./primitives";
import {
  DiagramArrow,
  DiagramReturnArrow,
  DiagramStep,
  MechanismDiagramShell,
} from "./primitives";

const ACCENT = "var(--mechanism-cdp)";

export const CDP_STRESS_FOOTNOTE =
  "stress: collateral cascade (DAI, Mar 2020)";

interface CdpDiagramProps {
  symbol: string;
  steps?: ReadonlyArray<{ label?: string; subtitle?: string }>;
  stressFootnote?: string;
}

export function CdpDiagram({
  symbol,
  steps: overrideSteps,
  stressFootnote = CDP_STRESS_FOOTNOTE,
}: CdpDiagramProps) {
  const defaults = [
    { label: "Crypto collateral", subtitle: "overcollateralized" },
    { label: "Vault / PSM", subtitle: "mint debt vs collateral" },
    { label: `${symbol} minted`, subtitle: "liquidates below ratio" },
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
      ariaLabel={`Users overcollateralize crypto in a vault to mint ${symbol} as debt; the position is liquidated if collateral falls below the safety ratio.`}
      description={`Users deposit crypto collateral worth more than the debt they want to issue; a vault or peg-stability module mints ${symbol} as debt against the collateral; the position is liquidated if the collateral value falls below the configured safety ratio.`}
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
        label="or liquidated"
        tone="danger"
        dashed
      />
    </MechanismDiagramShell>
  );
}
