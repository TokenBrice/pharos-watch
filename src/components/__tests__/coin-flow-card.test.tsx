import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CoinFlowCard } from "@/components/coin-flow-card";

const mintingProps = {
  symbol: "USDT",
  color: "#3b82f6",
  netFlow24hUsd: 1_240_000_000,
  pressureShiftScore: 58,
  netFlowDirection24h: "minting" as const,
  pressureShiftState: "improving" as const,
};

const burningProps = {
  symbol: "USDC",
  color: "#ef4444",
  netFlow24hUsd: -340_000_000,
  pressureShiftScore: -28,
  netFlowDirection24h: "burning" as const,
  pressureShiftState: "worsening" as const,
};

const nrProps = {
  symbol: "USDS",
  color: "#10b981",
  netFlow24hUsd: 0,
  pressureShiftScore: null,
  netFlowDirection24h: "inactive" as const,
  pressureShiftState: "nr" as const,
};

describe("CoinFlowCard", () => {
  it("renders symbol", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    expect(html).toContain("USDT");
  });

  it("renders formatted net 24h flow", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    expect(html).toContain("+$1.24B");
  });

  it("renders NR when pressureShiftScore is null", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...nrProps} />);
    expect(html).toContain("NR");
  });

  it("renders pressure shift score for burning coin", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...burningProps} />);
    // score is -28, badge now shows "Worsening -28"
    expect(html).toContain("-28");
  });

  it("renders band label in badge for minting coin", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    // pressureShiftState is "improving" → label is "Improving"
    expect(html).toContain("Improving");
  });

  it("renders band label in badge for burning coin", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...burningProps} />);
    // pressureShiftState is "worsening" → label is "Worsening"
    expect(html).toContain("Worsening");
  });

  it("renders pressure description narrative for minting improving coin", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    // direction=minting, state=improving → narrative from buildFlowSummaryNarrative
    expect(html).toContain("Minting, with issuance running stronger than its usual pace.");
  });

  it("renders pressure description narrative for burning worsening coin", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...burningProps} />);
    // direction=burning, state=worsening
    expect(html).toContain("Burning, with pressure worsening versus the baseline.");
  });

  it("does not render pressure description when pressureShiftScore is null", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...nrProps} />);
    // pressureDisplay is null → description row should not appear
    expect(html).not.toContain("No current activity");
  });

  it("renders a pressure bar track element", () => {
    const html = renderToStaticMarkup(<CoinFlowCard {...mintingProps} />);
    // The pressure bar container should be present
    expect(html).toContain("pressure-track");
  });
});
