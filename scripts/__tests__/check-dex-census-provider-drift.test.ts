import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { extractCensusRows, findDexCensusProviderDrift, runDexCensusProviderDriftCheck } from "../ci/check-dex-census-provider-drift";

const censusRow = {
  stablecoin_id: "usdc-circle", chain: "ethereum", contract_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  outcome: "unsupported", reason: "no-providers", observed_at: 1_800_000_000, provider_set_json: "[]",
};

describe("DEX census provider drift input admission", () => {
  it("rejects failed, unknown and mixed query envelopes instead of reporting clean empty coverage", () => {
    for (const payload of [{}, null, { success: false, results: [] },
      { success: true, results: [], errors: [{ message: "query failed" }] },
      { result: [{ success: true, results: [censusRow] }, { success: false, results: [] }] }]) {
      expect(() => extractCensusRows(payload)).toThrow(/d1-/);
    }
  });

  it("rejects malformed rows and provider JSON in raw arrays and admitted wrappers", () => {
    for (const badRow of [null, {}, { ...censusRow, stablecoin_id: "" }, { ...censusRow, observed_at: "1800000000" },
      { ...censusRow, outcome: null }, { ...censusRow, provider_set_json: "invalid" },
      { ...censusRow, provider_set_json: '["curve",1]' }]) {
      expect(() => extractCensusRows([badRow])).toThrow(/dex-census-/);
      expect(() => extractCensusRows({ success: true, results: [censusRow, badRow] })).toThrow(/dex-census-/);
    }
  });

  it("accepts explicit empty results and the documented direct empty row array", () => {
    for (const payload of [[], { success: true, results: [] }, { result: [{ success: true, results: [] }] }]) {
      expect(findDexCensusProviderDrift(extractCensusRows(payload))).toEqual({ scannedRowCount: 0, trackedRowCount: 0, drift: [] });
    }
  });

  it("preserves attribution and orphan exclusion across raw and nested Wrangler inputs", () => {
    const populated = { ...censusRow, provider_set_json: '["curve"]' };
    const orphan = { ...censusRow, stablecoin_id: "orphan" };
    const tracked = new Set([`usdc-circle|ethereum:${censusRow.contract_address}`]);
    const rows = [censusRow, populated, orphan];
    for (const payload of [rows, { result: [{ results: rows.slice(0, 1) }, { results: rows.slice(1) }] }]) {
      const report = findDexCensusProviderDrift(extractCensusRows(payload), tracked);
      expect(report).toMatchObject({ scannedRowCount: 3, trackedRowCount: 2, drift: [{
        stablecoinId: "usdc-circle", chain: "ethereum", address: censusRow.contract_address,
        liveProviders: expect.arrayContaining(["curve", "dexscreener"]),
      }] });
      expect(report.drift).toHaveLength(1);
    }
  });

  it("flags a persisted provider the live registry no longer resolves for the deployment", () => {
    const tracked = new Set([`usdc-circle|ethereum:${censusRow.contract_address}`]);
    const report = findDexCensusProviderDrift(extractCensusRows([
      { ...censusRow, provider_set_json: '["horizon"]' },
    ]), tracked);

    expect(report).toMatchObject({ scannedRowCount: 1, trackedRowCount: 1 });
    expect(report.drift).toHaveLength(1);
    expect(report.drift[0]).toMatchObject({
      persistedProviders: ["horizon"],
      liveProviders: expect.arrayContaining(["curve"]),
    });
    expect(report.drift[0]?.liveProviders).not.toContain("horizon");
  });

  it("reports zero-row CLI coverage but fails invalid input before emitting evaluation output", () => {
    const dir = mkdtempSync(join(tmpdir(), "dex-census-admission-"));
    const path = join(dir, "rows.json");
    const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      writeFileSync(path, JSON.stringify({ success: true, results: [] }));
      expect(runDexCensusProviderDriftCheck(["--rows", path])).toBe(0);
      expect(stdout.mock.calls.map(([text]) => String(text)).join("")).toContain("Census coverage: 0 rows, 0 tracked deployments.");
      stdout.mockClear();
      writeFileSync(path, JSON.stringify({ success: false, results: [] }));
      expect(() => runDexCensusProviderDriftCheck(["--rows", path])).toThrow("d1-query-failed");
      expect(stdout).not.toHaveBeenCalled();
    } finally { stdout.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });
});
