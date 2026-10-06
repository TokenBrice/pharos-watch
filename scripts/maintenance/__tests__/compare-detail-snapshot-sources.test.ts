import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as generator from "../../build-data/build-stablecoin-detail-snapshots";
import { compareDetailSnapshotSources, diffJsonFields } from "../compare-detail-snapshot-sources";

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
    expect(vi.mocked(generator.generateSnapshots).mock.calls.map(([, options]) => options?.source)).toEqual(["bulk", "per-coin"]);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({
      filesCompared: 2, differences: different ? ["usdc-circle.json"] : [], equivalent: !different,
      wallTimeMs: { bulk: expect.any(Number), "per-coin": expect.any(Number) },
      fieldDifferences: different ? [{
        file: "usdc-circle.json",
        fields: [{ path: '$["updatedAt"]["supplyHistory"]', kind: "missing-per-coin", bulk: 1000 }],
      }] : [],
    });
    for (const [, path] of vi.mocked(generator.writeSnapshots).mock.calls) {
      expect(path).not.toBe(generator.DETAIL_SNAPSHOT_OUTPUT_DIR);
      expect(existsSync(path!)).toBe(false);
    }
  });

  it("retains both trees under an explicitly selected parent and limits diagnostics", async () => {
    const parent = mkdtempSync(join(tmpdir(), "pharos-compare-test-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(generator.generateSnapshots).mockImplementation(async (_, options) =>
      ["usdt-tether", "usdc-circle"].map((id) => ({
        version: 1, stablecoinId: id, generatedAt: 1000,
        updatedAt: options?.source === "bulk" ? { supplyHistory: 1000 } : {}, lanes: {},
      })));
    try {
      expect(await compareDetailSnapshotSources(1000, { keepDir: parent, diffLimit: 1 })).toBe(false);
      const report = JSON.parse(String(log.mock.calls[0][0]));
      expect(report.differences).toHaveLength(2);
      expect(report.fieldDifferences).toHaveLength(1);
      expect(report.fieldDifferences[0].file).toBe("usdc-circle.json");
      expect(readdirSync(report.keptDir).sort()).toEqual(["bulk", "per-coin"]);
      for (const [, path] of vi.mocked(generator.writeSnapshots).mock.calls) expect(existsSync(path!)).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("reports values, omissions, arrays and key order without normalizing bytes", () => {
    expect(diffJsonFields({ a: 1, b: [{ price: 2 }] }, { b: [{ price: 3 }], a: 1 })).toEqual([
      { path: "$", kind: "key-order", perCoin: ["a", "b"], bulk: ["b", "a"] },
      { path: '$["b"][0]["price"]', kind: "value", perCoin: 2, bulk: 3 },
    ]);
    expect(diffJsonFields({ unavailable: null }, {})).toEqual([
      { path: '$["unavailable"]', kind: "missing-bulk", perCoin: null },
    ]);
    expect(diffJsonFields([1], [1, 2])).toEqual([
      { path: "$[1]", kind: "missing-per-coin", bulk: 2 },
    ]);
  });

  it.each([-1, 0.5, Number.NaN])("rejects an invalid diagnostic limit (%s) before acquisition", async (diffLimit) => {
    await expect(compareDetailSnapshotSources(1000, { diffLimit })).rejects.toThrow(/diffLimit/);
    expect(generator.generateSnapshots).not.toHaveBeenCalled();
  });

  it("restores the clock and fails closed when acquisition fails", async () => {
    const realNow = Date.now;
    vi.mocked(generator.generateSnapshots).mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(compareDetailSnapshotSources(1_800_000_000_000)).rejects.toThrow("upstream unavailable");
    expect(Date.now).toBe(realNow);
    expect(generator.writeSnapshots).not.toHaveBeenCalled();
  });
});
