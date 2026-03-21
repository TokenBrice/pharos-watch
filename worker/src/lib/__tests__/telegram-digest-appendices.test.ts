import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();

vi.mock("@shared/lib/dead-stablecoins", () => ({
  DEAD_STABLECOINS: [
    {
      name: "Palm USD",
      symbol: "PUSD",
      pegCurrency: "USD",
      causeOfDeath: "liquidity-drain",
      deathDate: "2026-01",
      peakMcap: 26_000_000,
      epitaph: "$2.8B promised. $81K left",
      obituary: "Palm USD obituary",
      sourceUrl: "https://example.com/pusd",
      sourceLabel: "Example",
    },
    {
      name: "Angle EURA",
      symbol: "EURA",
      pegCurrency: "EUR",
      causeOfDeath: "abandoned",
      deathDate: "2026-03",
      peakMcap: 200_000_000,
      epitaph: "DeFi's first Euro, last out",
      obituary: "Angle EURA obituary",
      sourceUrl: "https://example.com/eura",
      sourceLabel: "Example",
    },
    {
      name: "Angle USDA",
      symbol: "USDA",
      pegCurrency: "USD",
      causeOfDeath: "abandoned",
      deathDate: "2026-03",
      epitaph: "Late arrival, early exit",
      obituary: "Angle USDA obituary",
      sourceUrl: "https://example.com/usda",
      sourceLabel: "Example",
    },
  ],
}));

vi.mock("@shared/lib/stablecoins", () => ({
  TRACKED_STABLECOINS: [
    {
      id: "usdt-tether",
      symbol: "USDT",
      name: "Tether",
      status: "active",
      flags: { yieldBearing: false },
    },
    {
      id: "usdx-example",
      symbol: "USDX",
      name: "Example USD",
      status: "active",
      flags: { yieldBearing: false },
    },
    {
      id: "eurx-example",
      symbol: "EURX",
      name: "Example Euro",
      status: "pre-launch",
      flags: { yieldBearing: false },
    },
  ],
}));

vi.mock("../db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
}));

const {
  prepareTelegramDigestAppendices,
  CEMETERY_FOOTERS,
  queuePendingTrackedStablecoinAdditions,
} = await import("../telegram-digest-appendices");

describe("prepareTelegramDigestAppendices", () => {
  beforeEach(() => {
    mockGetCache.mockReset();
    mockSetCache.mockReset();
    mockSetCache.mockResolvedValue(undefined);
  });

  it("silently seeds cemetery and tracked snapshots on first run", async () => {
    mockGetCache.mockResolvedValue(null);

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.appendixHtml).toBeNull();
    expect(prepared.metadata).toMatchObject({
      hasAppendix: false,
      seededSnapshots: ["cemetery:first-run", "tracked:first-run"],
    });
    expect(mockSetCache).toHaveBeenCalledTimes(2);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "telegram:cemetery-snapshot",
      JSON.stringify([
        "PUSD|2026-01|palm usd",
        "EURA|2026-03|angle eura",
        "USDA|2026-03|angle usda",
      ]),
    ]);
    expect(mockSetCache.mock.calls[1]).toEqual([
      {},
      "telegram:tracked-stablecoins-snapshot",
      JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
    ]);

    await prepared.commitSuccess();
    expect(mockSetCache).toHaveBeenCalledTimes(2);
  });

  it("queues newly tracked active coins from the previous stablecoins cache baseline", async () => {
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "telegram:tracked-stablecoins-pending") {
        return {
          value: JSON.stringify(["usdt-tether"]),
          updatedAt: 1_778_500_000,
        };
      }
      return null;
    });

    const result = await queuePendingTrackedStablecoinAdditions(
      {} as D1Database,
      ["usdt-tether"],
      ["usdt-tether", "usdx-example"],
    );

    expect(result).toEqual({
      queuedIds: ["usdx-example"],
      totalPending: 2,
      baselineMissing: false,
    });
    expect(mockSetCache).toHaveBeenCalledTimes(1);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "telegram:tracked-stablecoins-pending",
      JSON.stringify(["usdt-tether", "usdx-example"]),
    ]);
  });

  it("uses queued tracked additions when the tracked snapshot is missing", async () => {
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "telegram:cemetery-snapshot") {
        return {
          value: JSON.stringify([
            "PUSD|2026-01|palm usd",
            "EURA|2026-03|angle eura",
            "USDA|2026-03|angle usda",
          ]),
          updatedAt: 1_778_500_000,
        };
      }
      if (key === "telegram:tracked-stablecoins-pending") {
        return {
          value: JSON.stringify(["usdx-example"]),
          updatedAt: 1_778_500_000,
        };
      }
      return null;
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.metadata).toMatchObject({
      hasAppendix: true,
      trackedDetected: 1,
      preLaunchDetected: 0,
      trackedSymbols: ["USDX"],
      seededSnapshots: ["tracked:first-run"],
    });
    expect(prepared.appendixHtml).toContain("<b>Tracking Changes</b>");
    expect(prepared.appendixHtml).toContain("<code>USDX</code> Example USD");

    expect(mockSetCache).not.toHaveBeenCalled();

    await prepared.commitSuccess();

    expect(mockSetCache).toHaveBeenCalledTimes(2);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "telegram:tracked-stablecoins-snapshot",
      JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
    ]);
    expect(mockSetCache.mock.calls[1]).toEqual([
      {},
      "telegram:tracked-stablecoins-pending",
      JSON.stringify([]),
    ]);
  });

  it("builds cemetery and tracking appendices, then advances snapshots only after commit", async () => {
    mockGetCache.mockImplementation(async (_db: unknown, key: string) => {
      if (key === "telegram:cemetery-snapshot") {
        return {
          value: JSON.stringify(["PUSD|2026-01|palm usd"]),
          updatedAt: 1_778_500_000,
        };
      }
      if (key === "telegram:cemetery-footer-index") {
        return {
          value: "8",
          updatedAt: 1_778_500_000,
        };
      }
      if (key === "telegram:tracked-stablecoins-snapshot") {
        return {
          value: JSON.stringify(["usdt-tether"]),
          updatedAt: 1_778_500_000,
        };
      }
      if (key === "telegram:tracked-stablecoins-pending") {
        return {
          value: JSON.stringify(["usdx-example"]),
          updatedAt: 1_778_500_000,
        };
      }
      return null;
    });

    const prepared = await prepareTelegramDigestAppendices({} as D1Database);

    expect(prepared.metadata).toMatchObject({
      hasAppendix: true,
      cemeteryDetected: 2,
      trackedDetected: 1,
      preLaunchDetected: 1,
      cemeterySymbols: ["EURA", "USDA"],
      trackedSymbols: ["USDX"],
      preLaunchSymbols: ["EURX"],
    });
    expect(prepared.appendixHtml).toContain("<b>New Cemetery Entries</b>");
    expect(prepared.appendixHtml).toContain("<code>EURA</code> Angle EURA (2026-03; Abandoned)");
    expect(prepared.appendixHtml).toContain("<i>DeFi's first Euro, last out</i>");
    expect(prepared.appendixHtml).toContain("Peak mcap: $200.00M");
    expect(prepared.appendixHtml).toContain(CEMETERY_FOOTERS[8]);
    expect(prepared.appendixHtml).toContain("<b>Tracking Changes</b>");
    expect(prepared.appendixHtml).toContain("Newly tracked stablecoins:");
    expect(prepared.appendixHtml).toContain("<code>USDX</code> Example USD");
    expect(prepared.appendixHtml).toContain("Newly tracked pre-launch stablecoins:");
    expect(prepared.appendixHtml).toContain("<code>EURX</code> Example Euro");

    expect(mockSetCache).not.toHaveBeenCalled();

    await prepared.commitSuccess();

    expect(mockSetCache).toHaveBeenCalledTimes(4);
    expect(mockSetCache.mock.calls[0]).toEqual([
      {},
      "telegram:cemetery-snapshot",
      JSON.stringify([
        "PUSD|2026-01|palm usd",
        "EURA|2026-03|angle eura",
        "USDA|2026-03|angle usda",
      ]),
    ]);
    expect(mockSetCache.mock.calls[1]).toEqual([
      {},
      "telegram:cemetery-footer-index",
      "9",
    ]);
    expect(mockSetCache.mock.calls[2]).toEqual([
      {},
      "telegram:tracked-stablecoins-snapshot",
      JSON.stringify(["usdt-tether", "usdx-example", "eurx-example"]),
    ]);
    expect(mockSetCache.mock.calls[3]).toEqual([
      {},
      "telegram:tracked-stablecoins-pending",
      JSON.stringify([]),
    ]);
  });
});
