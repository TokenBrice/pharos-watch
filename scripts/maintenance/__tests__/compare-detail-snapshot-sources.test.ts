import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import * as generator from "../../build-data/build-stablecoin-detail-snapshots";
import { compareDetailSnapshotSources } from "../compare-detail-snapshot-sources";

vi.mock("../../build-data/build-stablecoin-detail-snapshots", async (importOriginal) => {
  const actual = await importOriginal<typeof generator>();
  return { ...actual, generateSnapshots: vi.fn(), writeSnapshots: vi.fn(actual.writeSnapshots) };
});
afterEach(() => { vi.restoreAllMocks(); vi.mocked(generator.generateSnapshots).mockReset(); vi.mocked(generator.writeSnapshots).mockClear(); });

describe("detail snapshot source equivalence proof", () => {
  it.each([false, true])("compares all generated file bytes and removes temporary trees (difference=%s)", async (different) => {
    const generatedAt = 1_800_000_000_000;
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(generator.generateSnapshots).mockImplementation(async (bootstrap, options) => {
      expect(bootstrap).toBe(false);
      expect(Date.now()).toBe(generatedAt);
      expect(options?.generatedAt).toBe(generatedAt);
      return ["usdt-tether", "usdc-circle"].map((id) => ({
        version: 1,
        stablecoinId: id,
        generatedAt,
        updatedAt: different && options?.source === "bulk" && id === "usdc-circle" ? { supplyHistory: 1000 } : {},
        lanes: {},
      }));
    });
    const realNow = Date.now;
    expect(await compareDetailSnapshotSources(generatedAt)).toBe(!different);
    expect(Date.now).toBe(realNow);
    expect(vi.mocked(generator.generateSnapshots).mock.calls.map(([, options]) => options?.source)).toEqual(["per-coin", "bulk"]);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ filesCompared: 2, differences: different ? ["usdc-circle.json"] : [], equivalent: !different });
    for (const [, path] of vi.mocked(generator.writeSnapshots).mock.calls) {
      expect(path).not.toBe(generator.DETAIL_SNAPSHOT_OUTPUT_DIR);
      expect(existsSync(path!)).toBe(false);
    }
  });

  it("restores the clock and fails closed when acquisition fails", async () => {
    const realNow = Date.now;
    vi.mocked(generator.generateSnapshots).mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(compareDetailSnapshotSources(1_800_000_000_000)).rejects.toThrow("upstream unavailable");
    expect(Date.now).toBe(realNow);
    expect(generator.writeSnapshots).not.toHaveBeenCalled();
  });
});
