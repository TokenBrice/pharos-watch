import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { KpiBar } from "@/components/kpi-bar";

const { psiMock, stablecoinsMock, pegSummaryMock, dexMock, flowsMock, stressMock } = vi.hoisted(() => ({
  psiMock: vi.fn(),
  stablecoinsMock: vi.fn(),
  pegSummaryMock: vi.fn(),
  dexMock: vi.fn(),
  flowsMock: vi.fn(),
  stressMock: vi.fn(),
}));

vi.mock("@/hooks/api-hooks", () => ({
  useStabilityIndex: psiMock,
  usePegSummary: pegSummaryMock,
  useDexLiquidity: dexMock,
  useStressSignals: stressMock,
}));

vi.mock("@/hooks/use-stablecoins", () => ({
  useStablecoins: stablecoinsMock,
}));

vi.mock("@/hooks/use-mint-burn-flows", () => ({
  useMintBurnFlows: flowsMock,
}));

vi.mock("@/components/methodology-hint", () => ({
  MethodologyHint: ({ topic }: { topic: string }) => <span data-testid={`methodology-hint-${topic}`} />,
  MethodologyLabel: ({ children, topic }: { children: ReactNode; topic: string }) => (
    <span>
      <span>{children}</span>
      <span data-testid={`methodology-hint-${topic}`} />
    </span>
  ),
}));

function primeHooks() {
  psiMock.mockReturnValue({
    data: {
      current: {
        score: 88.5,
        band: "BEDROCK",
        severity: 0,
        breadth: 0,
        stressBreadth: 0,
        trend: 0,
        computedAt: 1_750_000_000,
        coverage: { coins: 190, withPrice: 190 },
      },
      history: [
        {
          date: 1_750_000_000 - 86_400,
          score: 88.5,
          band: "BEDROCK",
          severity: 0,
          breadth: 0,
          stressBreadth: 0,
          trend: 0,
          computedAt: 1_750_000_000 - 86_400,
        },
      ],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });

  stablecoinsMock.mockReturnValue({
    data: {
      peggedAssets: [
        {
          id: "usdt-tether",
          symbol: "USDT",
          name: "Tether",
          pegType: "peggedUSD",
          price: 1,
          circulating: { peggedUSD: 100_000_000_000 },
          circulatingPrevDay: { peggedUSD: 99_900_000_000 },
          circulatingPrevWeek: { peggedUSD: 99_000_000_000 },
          chains: ["ethereum"],
        },
        {
          id: "usdc-circle",
          symbol: "USDC",
          name: "USD Coin",
          pegType: "peggedUSD",
          price: 1,
          circulating: { peggedUSD: 40_000_000_000 },
          circulatingPrevDay: { peggedUSD: 39_900_000_000 },
          circulatingPrevWeek: { peggedUSD: 39_500_000_000 },
          chains: ["ethereum"],
        },
      ],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });

  pegSummaryMock.mockReturnValue({
    data: {
      summary: { coinsAtPeg: 137, totalTracked: 147 },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });

  dexMock.mockReturnValue({
    data: {
      "usdt-tether": {
        totalVolume24hUsd: 2_000_000_000,
        totalVolume7dUsd: 14_000_000_000,
      },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });

  flowsMock.mockReturnValue({
    data: {
      coins: [
        {
          id: "usdt-tether",
          netFlow24hUsd: 50_000_000,
          netFlow7dUsd: 99_400_000,
        },
      ],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });

  stressMock.mockReturnValue({
    data: {
      signals: {
        "coin-a": { band: "ALERT", score: 60 },
        "coin-b": { band: "ALERT", score: 55 },
        "coin-c": { band: "ALERT", score: 52 },
        "coin-d": { band: "ALERT", score: 51 },
        "coin-e": { band: "ALERT", score: 50 },
      },
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  });
}

describe("KpiBar copy (Task 1.1)", () => {
  it("renders clarified KPI labels and unit microcopy", () => {
    primeHooks();
    const html = renderToStaticMarkup(<KpiBar />);

    // 7d net (was "7d total")
    expect(html).toMatch(/7d net/);
    expect(html).not.toMatch(/7d total/);

    // DEWS should read as a count, colon killed
    expect(html).toMatch(/DEWS 5 on alert/);
    expect(html).not.toMatch(/DEWS:\s*<\/span>/);

    // USDT+USDC gets spaces around the plus sign
    expect(html).toMatch(/USDT \+ USDC share/);
    expect(html).not.toMatch(/USDT\+USDC share/);

    // PSI primary shows "BEDROCK · 11d in band" form (days can vary; match the structure)
    expect(html).toMatch(/BEDROCK\s·\s\d+d in band/);
    expect(html).not.toMatch(/BEDROCK for \d+d/);

    // Methodology hints attached to vs 7d avg, Turnover
    expect(html).toContain("vs 7d avg");
    expect(html).toContain("Turnover");
    expect(html).toContain('data-testid="methodology-hint-dexVolVsAvg"');
    expect(html).toContain('data-testid="methodology-hint-turnover"');
  });

});
