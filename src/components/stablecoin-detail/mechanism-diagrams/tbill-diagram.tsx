import { ThreeStepMechanismDiagram } from "./three-step-diagram";

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
  const defaultSteps = [
    { label: "Investor cash", subtitle: "subscribed via fund" },
    { label: "T-Bills + Repos", subtitle: "short-duration RWA" },
    { label: `${symbol} units`, subtitle: "NAV accrues daily" },
  ] as const;

  return (
    <ThreeStepMechanismDiagram
      ariaLabel={`Investor cash funds a short-duration Treasury portfolio; ${symbol} units accrue NAV daily.`}
      description={`Investors subscribe cash into a regulated fund; the fund deploys into short-duration T-Bills and repurchase agreements; ${symbol} units represent fund shares whose NAV accrues daily from the underlying yield.`}
      accentColor={ACCENT}
      defaultSteps={defaultSteps}
      overrideSteps={overrideSteps}
      stressFootnote={stressFootnote}
    />
  );
}
