import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../enrich-prices-shared";
import { runEnrichmentPasses, type EnrichmentPassProgress } from "../enrich-prices-fallback";
import { makePeggedAsset } from "./_fixtures";

const passes = vi.hoisted(() => ({
  dl: vi.fn(), cmc: vi.fn(), jupiter: vi.fn(), dex: vi.fn(), cg: vi.fn(),
}));
vi.mock("../enrich-prices-defillama-pass", () => ({ runDlContractPasses: passes.dl }));
vi.mock("../enrich-prices-cmc-pass", () => ({ runCmcPass: passes.cmc }));
vi.mock("../enrich-prices-jupiter-pass", () => ({ runJupiterPass: passes.jupiter }));
vi.mock("../enrich-prices-dexscreener-pass", () => ({ runDexScreenerPass: passes.dex }));
vi.mock("../enrich-prices-coingecko-low-volume-pass", () => ({ runCoingeckoLowVolumePass: passes.cg }));

describe("missing-price pass runner", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    passes.dl.mockResolvedValue({ pass1: 0, pass1b: 0, failures: [] });
    for (const pass of [passes.cmc, passes.jupiter, passes.dex, passes.cg]) {
      pass.mockResolvedValue({ resolved: 0, failures: [] });
    }
  });

  it("continues after a failed provider and reports the later recovered quote and ordered progress", async () => {
    const assets = [makePeggedAsset({ price: null })];
    passes.cmc.mockRejectedValue(new Error("provider unavailable"));
    passes.jupiter.mockImplementation(async (rows: PeggedAsset[]) => {
      rows[0].price = 0.99;
      return { resolved: 1, failures: [] };
    });
    const progress: EnrichmentPassProgress[] = [];
    const result = await runEnrichmentPasses({
      assets,
      onProgress: (row) => { progress.push({ ...row, counts: { ...row.counts } }); },
    });

    expect(assets[0].price).toBe(0.99);
    expect(result).toEqual({
      counts: { pass1: 0, pass1b: 0, passCmc: 0, passJupiter: 1, passDex: 0, passCgLowVolume: 0 },
      failedPasses: ["coinmarketcap"],
      providerDiagnostics: [],
    });
    expect(progress.filter((row) => row.phase === "pass-start").map((row) => row.passKey)).toEqual([
      "pass1", "passCmc", "passJupiter", "passDex", "passCgLowVolume",
    ]);
    expect(progress.find((row) => row.phase === "pass-failed")).toMatchObject({
      passKey: "passCmc", missingBeforePass: 1, missingAfterPass: 1, failedPasses: ["coinmarketcap"],
    });
    expect(progress.find((row) => row.phase === "pass-complete" && row.passKey === "passJupiter")).toMatchObject({
      missingBeforePass: 1, missingAfterPass: 0, counts: { passJupiter: 1 },
    });
    expect(progress[progress.length - 1]).toMatchObject({ missingAfterPass: 0, counts: { passJupiter: 1 } });
  });

  it("propagates cancellation instead of reporting provider failure and running later passes", async () => {
    const controller = new AbortController();
    const failure = new Error("cancelled during provider read");
    passes.dl.mockImplementation(async () => { controller.abort(); throw failure; });
    const assets = [makePeggedAsset({ price: null })];
    const progress: EnrichmentPassProgress[] = [];
    await expect(runEnrichmentPasses({
      assets, signal: controller.signal, onProgress: (row) => { progress.push(row); },
    })).rejects.toBe(failure);
    expect(assets[0].price).toBeNull();
    expect(progress.map((row) => row.phase)).toEqual(["pass-start"]);
    expect(passes.cmc).not.toHaveBeenCalled();
    expect(passes.jupiter).not.toHaveBeenCalled();
    expect(passes.dex).not.toHaveBeenCalled();
    expect(passes.cg).not.toHaveBeenCalled();
  });
});
