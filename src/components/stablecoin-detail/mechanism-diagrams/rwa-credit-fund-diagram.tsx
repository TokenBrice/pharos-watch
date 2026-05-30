import { ThreeStepMechanismDiagram } from "./three-step-diagram";

const ACCENT = "var(--mechanism-rwa-credit-fund)";

const RWA_CREDIT_FUND_STRESS_FOOTNOTE =
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
  const defaultSteps = [
    { label: "Investor cash", subtitle: "subscribed via fund (KYC)" },
    { label: "Private credit / CLO", subtitle: "credit risk, illiquid" },
    { label: `${symbol} fund-share`, subtitle: "NAV reflects credit losses" },
  ] as const;

  return (
    <ThreeStepMechanismDiagram
      ariaLabel={`Accredited investor cash funds a private-credit or CLO portfolio; ${symbol} fund-share NAV reflects credit losses with quarterly redemption gates.`}
      description={`Accredited investors subscribe cash into a regulated credit fund; the fund deploys into private credit, CLOs, or structured debt with real default risk and limited liquidity; ${symbol} represents a fund share whose NAV reflects credit performance, with redemptions typically allowed only at quarterly windows.`}
      accentColor={ACCENT}
      defaultSteps={defaultSteps}
      overrideSteps={overrideSteps}
      stressFootnote={stressFootnote}
      returnArrow={{
        fromX: 500,
        toX: 75,
        topY: 90,
        peakY: 140,
        label: "quarterly redemption",
        strokeWidth: 1.2,
        dashed: true,
      }}
    />
  );
}
