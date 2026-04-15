import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportCard } from "@shared/types";
import type { UpstreamExposure } from "../portfolio-analysis";
import { computeGroupedExposure } from "../portfolio-analysis";

type SyntheticStablecoin = {
  id: string;
  name: string;
  symbol: string;
  flags: { backing: string };
  reserves?: Array<{ name: string; pct: number; risk: string }>;
};

function syntheticCoin(
  id: string,
  options: Partial<SyntheticStablecoin> = {},
): SyntheticStablecoin {
  return {
    id,
    name: options.name ?? id,
    symbol: options.symbol ?? id.slice(0, 4).toUpperCase(),
    flags: options.flags ?? { backing: "rwa-backed" },
    reserves: options.reserves,
  };
}

function cardWithDependencies(
  id: string,
  dependencies: Array<{ id: string; weight: number }> = [],
): ReportCard {
  return {
    id,
    rawInputs: { dependencies },
  } as ReportCard;
}

async function importWithStablecoins(stablecoins: SyntheticStablecoin[]) {
  vi.resetModules();
  vi.doMock("@shared/lib/stablecoins", () => ({
    ACTIVE_STABLECOINS: stablecoins,
  }));
  return import("../portfolio-analysis");
}

function expectFiniteExposure(rows: readonly UpstreamExposure[]): void {
  for (const row of rows) {
    expect(Number.isFinite(row.usd)).toBe(true);
    expect(Number.isFinite(row.pct)).toBe(true);
  }
}

afterEach(() => {
  vi.doUnmock("@shared/lib/stablecoins");
  vi.resetModules();
});

describe("computeUpstreamExposure", () => {
  it("falls back to backing collateral when reserve percentages sum to zero", async () => {
    const { computeUpstreamExposure } = await importWithStablecoins([
      syntheticCoin("synthetic-zero", {
        reserves: [
          { name: "Treasury Bills", pct: 0, risk: "very-low" },
          { name: "Cash", pct: 0, risk: "very-low" },
        ],
      }),
    ]);

    const exposure = computeUpstreamExposure(
      [{ coinId: "synthetic-zero", amount: 100 }],
      [],
    );

    expectFiniteExposure(exposure);
    expect(exposure).toEqual([
      expect.objectContaining({
        name: "Real-World Assets (RWA)",
        usd: 100,
        pct: 100,
        isCollateral: true,
      }),
    ]);
  });

  it("allocates mixed zero and nonzero reserve slices across positive slices only", async () => {
    const { computeUpstreamExposure } = await importWithStablecoins([
      syntheticCoin("synthetic-mixed", {
        reserves: [
          { name: "Treasury Bills", pct: 100, risk: "very-low" },
          { name: "Cash", pct: 0, risk: "very-low" },
        ],
      }),
    ]);

    const exposure = computeUpstreamExposure(
      [{ coinId: "synthetic-mixed", amount: 250 }],
      [],
    );

    expectFiniteExposure(exposure);
    expect(exposure).toEqual([
      expect.objectContaining({
        name: "Treasury Bills",
        usd: 250,
        pct: 100,
      }),
    ]);
  });

  it("falls back when dependency remainder filtering leaves no non-stable reserve slices", async () => {
    const { computeUpstreamExposure } = await importWithStablecoins([
      syntheticCoin("usdc-circle", { name: "USD Coin", symbol: "USDC" }),
      syntheticCoin("synthetic-wrapper", {
        flags: { backing: "crypto-backed" },
        reserves: [{ name: "USDC reserve", pct: 100, risk: "low" }],
      }),
    ]);

    const exposure = computeUpstreamExposure(
      [{ coinId: "synthetic-wrapper", amount: 100 }],
      [cardWithDependencies("synthetic-wrapper", [{ id: "usdc-circle", weight: 0.4 }])],
    );

    expectFiniteExposure(exposure);
    expect(exposure).toEqual([
      expect.objectContaining({
        coinId: "usdc-circle",
        usd: 40,
        pct: 40,
        isCollateral: false,
      }),
      expect.objectContaining({
        name: "Crypto Collateral",
        usd: 60,
        pct: 60,
        isCollateral: true,
      }),
    ]);
  });

  it("aggregates upstream stablecoin dependency exposure by id", async () => {
    const { computeUpstreamExposure } = await importWithStablecoins([
      syntheticCoin("usdc-circle", { name: "USD Coin", symbol: "USDC" }),
      syntheticCoin("synthetic-a"),
      syntheticCoin("synthetic-b"),
    ]);

    const exposure = computeUpstreamExposure(
      [
        { coinId: "synthetic-a", amount: 75 },
        { coinId: "synthetic-b", amount: 25 },
      ],
      [
        cardWithDependencies("synthetic-a", [{ id: "usdc-circle", weight: 1 }]),
        cardWithDependencies("synthetic-b", [{ id: "usdc-circle", weight: 1 }]),
      ],
    );

    expectFiniteExposure(exposure);
    expect(exposure).toEqual([
      expect.objectContaining({
        coinId: "usdc-circle",
        usd: 100,
        pct: 100,
        isCollateral: false,
      }),
    ]);
  });

  it("uses the backing fallback for holdings without known metadata", async () => {
    const { computeUpstreamExposure } = await importWithStablecoins([]);

    const exposure = computeUpstreamExposure(
      [{ coinId: "unknown-coin", amount: 50 }],
      [],
    );

    expectFiniteExposure(exposure);
    expect(exposure).toEqual([
      expect.objectContaining({
        name: "Real-World Assets (RWA)",
        usd: 50,
        pct: 100,
      }),
    ]);
  });

  it("keeps representative real registry exposure values finite", async () => {
    vi.resetModules();
    vi.doUnmock("@shared/lib/stablecoins");
    const { computeUpstreamExposure: computeRealExposure } = await import("../portfolio-analysis");

    const exposure = computeRealExposure(
      [
        { coinId: "usdc-circle", amount: 100 },
        { coinId: "dai-makerdao", amount: 50 },
      ],
      [],
    );
    const grouped = computeGroupedExposure(exposure, 150);

    expectFiniteExposure(exposure);
    expectFiniteExposure(grouped);
  });
});

describe("computeGroupedExposure", () => {
  it("recalculates grouped collateral percentages from the supplied total", () => {
    const grouped = computeGroupedExposure(
      [
        {
          coinId: "__collateral_treasury_bills__",
          name: "Treasury Bills",
          symbol: "Treasury Bills",
          usd: 100,
          pct: 1,
          isCollateral: true,
        },
        {
          coinId: "__collateral_t_bills__",
          name: "T-Bills",
          symbol: "T-Bills",
          usd: 50,
          pct: 1,
          isCollateral: true,
        },
      ],
      400,
    );

    expect(grouped).toEqual([
      expect.objectContaining({
        name: "U.S. Treasury Bills",
        usd: 150,
        pct: 37.5,
        isCollateral: true,
      }),
    ]);
  });
});
