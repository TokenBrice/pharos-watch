// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportCard, StablecoinMeta } from "@shared/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

import { FreezablePill } from "../hero-card-identity";

const COIN: StablecoinMeta = {
  id: "usdc-circle",
  symbol: "USDC",
  name: "USD Coin",
  flags: {
    backing: "rwa-backed",
    governance: "centralized",
    pegCurrency: "USD",
    yieldBearing: false,
    rwa: true,
    navToken: false,
  },
};

const NON_BLACKLIST_COIN: StablecoinMeta = {
  ...COIN,
  id: "dai-makerdao",
  symbol: "DAI",
  name: "Dai",
};

function makeReportCard(canBeBlacklisted: ReportCard["rawInputs"]["canBeBlacklisted"]): ReportCard {
  return {
    id: COIN.id,
    name: COIN.name,
    symbol: COIN.symbol,
    overallGrade: "B",
    overallScore: 70,
    baseScore: 70,
    dimensions: {
      pegStability: { grade: "B", score: 70, detail: "" },
      liquidity: { grade: "B", score: 70, detail: "" },
      resilience: { grade: "B", score: 70, detail: "" },
      decentralization: { grade: "B", score: 70, detail: "" },
      dependencyRisk: { grade: "B", score: 70, detail: "" },
    },
    ratedDimensions: 5,
    rawInputs: {
      pegScore: 95,
      activeDepeg: false,
      activeDepegBps: null,
      depegEventCount: 0,
      lastEventAt: null,
      liquidityScore: 70,
      effectiveExitScore: null,
      redemptionBackstopScore: null,
      redemptionRouteFamily: null,
      redemptionModelConfidence: null,
      redemptionUsedForLiquidity: false,
      redemptionImmediateCapacityUsd: null,
      redemptionImmediateCapacityRatio: null,
      concentrationHhi: null,
      bluechipGrade: null,
      canBeBlacklisted,
      chainTier: "ethereum",
      deploymentModel: "native-multichain",
      collateralQuality: "rwa",
      custodyModel: "institutional-regulated",
      governanceTier: "centralized",
      governanceQuality: "regulated-entity",
      dependencies: [],
      navToken: false,
      collateralFromLive: false,
    },
    isDefunct: false,
  };
}

describe("FreezablePill", () => {
  afterEach(cleanup);

  it("returns null when reportCard is null", () => {
    const { container } = render(<FreezablePill coin={COIN} reportCard={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders 'Freezable' when canBeBlacklisted === true", () => {
    const { getByRole } = render(
      <FreezablePill coin={COIN} reportCard={makeReportCard(true)} />,
    );
    const link = getByRole("link");
    expect(link.textContent).toContain("Freezable");
  });

  it("renders 'Dilutable' when canBeBlacklisted === 'dilutable'", () => {
    const { getByRole } = render(
      <FreezablePill coin={COIN} reportCard={makeReportCard("dilutable")} />,
    );
    const link = getByRole("link");
    expect(link.textContent).toContain("Dilutable");
  });

  it("renders 'Possible Freeze' when canBeBlacklisted === 'possible'", () => {
    const { getByRole } = render(
      <FreezablePill coin={COIN} reportCard={makeReportCard("possible")} />,
    );
    const link = getByRole("link");
    expect(link.textContent).toContain("Possible Freeze");
  });

  it("renders 'Upstream Freeze' when canBeBlacklisted === 'inherited'", () => {
    const { getByRole } = render(
      <FreezablePill coin={COIN} reportCard={makeReportCard("inherited")} />,
    );
    const link = getByRole("link");
    expect(link.textContent).toContain("Upstream Freeze");
  });

  it("renders 'Unfreezable' when canBeBlacklisted === false", () => {
    const { getByRole } = render(
      <FreezablePill coin={COIN} reportCard={makeReportCard(false)} />,
    );
    const link = getByRole("link");
    expect(link.textContent).toContain("Unfreezable");
  });

  it("links BLACKLIST_STABLECOINS symbols to #blacklist", () => {
    const { getByRole } = render(
      <FreezablePill coin={COIN} reportCard={makeReportCard(true)} />,
    );
    const link = getByRole("link");
    expect(link.getAttribute("href")).toBe("#blacklist");
  });

  it("links non-BLACKLIST_STABLECOINS symbols to the canonical FreezeWatch stablecoin filter", () => {
    const { getByRole } = render(
      <FreezablePill coin={NON_BLACKLIST_COIN} reportCard={makeReportCard("dilutable")} />,
    );
    const link = getByRole("link");
    expect(link.getAttribute("href")).toBe("/freezewatch/?stablecoin=DAI");
  });
});
