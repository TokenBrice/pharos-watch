import { afterEach, describe, expect, it, vi } from "vitest";
import { runFreezeStablecoin } from "../maintenance/freeze-stablecoin";

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
    { name: "absent asset", key: "key", responses: [Response.json({ peggedAssets: [{ id: "other" }] })], error: /not found/ },
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
