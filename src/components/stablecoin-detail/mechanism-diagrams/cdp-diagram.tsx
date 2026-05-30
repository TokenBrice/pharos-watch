import { ThreeStepMechanismDiagram } from "./three-step-diagram";

const ACCENT = "var(--mechanism-cdp)";

const CDP_STRESS_FOOTNOTE =
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
  const defaultSteps = [
    { label: "Crypto collateral", subtitle: "overcollateralized" },
    { label: "Vault / PSM", subtitle: "mint debt vs collateral" },
    { label: `${symbol} minted`, subtitle: "liquidates below ratio" },
  ] as const;

  return (
    <ThreeStepMechanismDiagram
      ariaLabel={`Users overcollateralize crypto in a vault to mint ${symbol} as debt; the position is liquidated if collateral falls below the safety ratio.`}
      description={`Users deposit crypto collateral worth more than the debt they want to issue; a vault or peg-stability module mints ${symbol} as debt against the collateral; the position is liquidated if the collateral value falls below the configured safety ratio.`}
      accentColor={ACCENT}
      defaultSteps={defaultSteps}
      overrideSteps={overrideSteps}
      stressFootnote={stressFootnote}
      returnArrow={{
        fromX: 500,
        toX: 75,
        topY: 90,
        peakY: 140,
        label: "or liquidated",
        tone: "danger",
        dashed: true,
      }}
    />
  );
}
