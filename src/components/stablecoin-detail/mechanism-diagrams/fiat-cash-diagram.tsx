import { ThreeStepMechanismDiagram } from "./three-step-diagram";

const ACCENT = "var(--mechanism-fiat-cash)";

const FIAT_CASH_STRESS_FOOTNOTE =
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
  const defaultSteps = [
    { label: "User USD", subtitle: "wire / ACH" },
    { label: "Issuer reserves", subtitle: "custodied 1:1" },
    { label: `${symbol} minted`, subtitle: "redeem any time" },
  ] as const;

  return (
    <ThreeStepMechanismDiagram
      ariaLabel={`${symbol} mechanism: user dollars in, custodied 1:1, redeemable on demand`}
      description={`Users send USD via wire or ACH to the issuer; the issuer custodies the dollars in cash, repos, and short-term Treasuries; the issuer mints ${symbol} 1:1 and lets holders redeem at any time.`}
      accentColor={ACCENT}
      defaultSteps={defaultSteps}
      overrideSteps={overrideSteps}
      stressFootnote={stressFootnote}
      returnArrow={{
        fromX: 500,
        toX: 275,
        topY: 90,
        peakY: 140,
        label: "redeem",
        strokeWidth: 1.2,
      }}
    />
  );
}
