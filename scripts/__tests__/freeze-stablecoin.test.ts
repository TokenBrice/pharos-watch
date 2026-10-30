import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSupplyHistorySnapshot, runFreezeStablecoin } from "../maintenance/freeze-stablecoin";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("runFreezeStablecoin", () => {
  it("acquires either supply envelope and prints the selected asset with rounded peak and UTC death month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-27T01:02:03Z"));
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const history = [{ circulatingUsd: 1.2 }, { circulatingUsd: 1234.6 }, { circulatingUsd: 500 }];
    for (const body of [history, { history }]) {
      log.mockClear();
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(Response.json({ peggedAssets: [{ id: "other" }, { id: "fixture", symbol: "FXT" }] }))
        .mockResolvedValueOnce(Response.json(body)));
      await runFreezeStablecoin(["fixture"]);
      const printed = log.mock.calls.map(([value]) => String(value)).filter((value) => value.startsWith("{"))
        .map((value) => JSON.parse(value));
      expect(printed).toEqual([
        { id: "fixture", capturedAt: "2026-04-27T01:02:03.000Z", peggedAssetRow: { id: "fixture", symbol: "FXT" } },
        expect.objectContaining({ status: "frozen", frozenAt: "2026-04-27",
          obituary: expect.objectContaining({ peakMcap: 1235, deathDate: "2026-04" }) }),
      ]);
    }
  });

  it.each([
    { name: "missing API key", key: "", responses: [], error: /PHAROS_API_KEY/ },
    { name: "HTTP failure at either endpoint", key: "key", responses: [new Response(null, { status: 503 })], error: /503/ },
    { name: "absent and unregistered asset", key: "key", responses: [Response.json({ peggedAssets: [{ id: "other" }] })], error: /missing from \/api\/stablecoins and the stablecoin registry/ },
    { name: "empty or nonpositive history", key: "key", responses: [], error: /unable to compute peakMcap/ },
  ])("rejects $name without printing an actionable plan", async ({ name, key, responses, error }) => {
    vi.stubEnv("PHAROS_API_KEY", key);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const histories = name === "empty or nonpositive history" ? [[], [{ circulatingUsd: 0 }, { circulatingUsd: -1 }]] : [null];
    for (const history of histories) {
      const queue = history === null ? responses : [Response.json({ peggedAssets: [{ id: "fixture" }] }), Response.json(history)];
      vi.stubGlobal("fetch", vi.fn(async () => queue.shift()!));
      await expect(runFreezeStablecoin(["fixture"])).rejects.toThrow(error);
    }
    if (name === "HTTP failure at either endpoint") {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ peggedAssets: [{ id: "fixture" }] }))
        .mockResolvedValueOnce(new Response(null, { status: 502 })));
      await expect(runFreezeStablecoin(["fixture"])).rejects.toThrow(/502/);
    }
    expect(log.mock.calls.map(([value]) => String(value)).filter((value) => value.startsWith("{"))).toEqual([]);
  });
});

describe("supply-history fallback", () => {
  const identity = { name: "Kinka", symbol: "XNK", backing: "rwa-backed", pegCurrency: "GOLD" };

  it("uses the newest observed supply point, registry identity and an unavailable price", () => {
    const newest = 1_790_000_000;
    const snapshot = buildSupplyHistorySnapshot({
      coinId: "xnk-kinka",
      identity,
      points: [
        { date: 1_770_000_000, circulatingUsd: 1250.4 },
        { date: newest, circulatingUsd: 980.2 },
      ],
    });
    expect(snapshot).toEqual({
      capturedAt: new Date(newest * 1000).toISOString(),
      peakMcap: 1250,
      peggedAssetRow: {
        id: "xnk-kinka",
        name: "Kinka",
        symbol: "XNK",
        pegType: "peggedGOLD",
        pegMechanism: "rwa-backed",
        price: null,
        priceSource: "missing",
        supplySource: "supply-history",
        circulating: { peggedGOLD: 980.2 },
        circulatingPrevDay: {},
        circulatingPrevWeek: {},
        circulatingPrevMonth: {},
        chainCirculating: {},
        chains: [],
      },
    });
  });

  it("keeps an explicit zero on the newest row as observed supply", () => {
    const snapshot = buildSupplyHistorySnapshot({
      coinId: "xnk-kinka",
      identity,
      points: [{ date: 1_770_000_000, circulatingUsd: 100 }, { date: 1_790_000_000, circulatingUsd: 0 }],
    });
    expect(snapshot.peggedAssetRow.circulating).toEqual({ peggedGOLD: 0 });
  });

  it.each([
    { name: "no positive observation", identity, points: [{ date: 1, circulatingUsd: null }], error: /unable to compute peakMcap/ },
    { name: "no rows", identity, points: [], error: /unable to compute peakMcap/ },
    { name: "unknown currency", identity: { ...identity, pegCurrency: "XYZ" }, points: [{ date: 1, circulatingUsd: 10 }], error: /cannot derive a peg type/ },
  ])("fails closed on $name", ({ identity: caseIdentity, points, error }) => {
    expect(() => buildSupplyHistorySnapshot({ coinId: "xnk-kinka", identity: caseIdentity, points })).toThrow(error);
  });

  it("prints a fallback plan when the live payload omits the coin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-30T09:00:00Z"));
    vi.stubEnv("PHAROS_API_KEY", "fixture-key");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ peggedAssets: [{ id: "usdc-circle" }] }))
      .mockResolvedValueOnce(Response.json([
        { date: 1_790_000_000, circulatingUsd: 1250.4, price: 0.98 },
        { date: 1_793_000_000, circulatingUsd: 980.2, price: 0.97 },
      ]));
    vi.stubGlobal("fetch", fetchMock);

    await runFreezeStablecoin(["xnk-kinka"]);

    expect(String(fetchMock.mock.calls[1][0])).toContain("stablecoin=xnk-kinka&range=all");
    const printed = log.mock.calls.map(([value]) => String(value)).filter((value) => value.startsWith("{"))
      .map((value) => JSON.parse(value));
    expect(printed).toEqual([
      {
        id: "xnk-kinka",
        capturedAt: new Date(1_793_000_000 * 1000).toISOString(),
        peggedAssetRow: expect.objectContaining({
          price: null,
          priceSource: "missing",
          supplySource: "supply-history",
          circulating: { peggedGOLD: 980.2 },
        }),
      },
      expect.objectContaining({ status: "frozen", frozenAt: "2026-10-30",
        obituary: expect.objectContaining({ peakMcap: 1250, deathDate: "2026-10" }) }),
    ]);
    expect(log.mock.calls.map(([value]) => String(value)))
      .toContain("Fallback snapshot: supply observed 2026-10-26T07:33:20.000Z from /api/supply-history; price unavailable.");
  });
});
