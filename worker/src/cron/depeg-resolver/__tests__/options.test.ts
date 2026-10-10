import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { normalizeComputeOptions } from "../options";
import { DEFAULT_DDR_V2_STORE_CONTRACTS } from "../storage-adapters";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

describe("normalizeComputeOptions", () => {
  it("allocates distinct run identities and healthy defaults for the database shorthand", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_780_358_400_999);
    const { db } = fixtures.open();
    const signal = new AbortController().signal;
    const first = normalizeComputeOptions(db, signal);
    const second = normalizeComputeOptions(db);

    expect(first).toMatchObject({
      db, signal, runAt: 1_780_358_400, slot: "quarter-hour",
      stablecoinsCacheSafe: true, depegPipelineHealthy: true,
    });
    expect(first.storeContracts).toBe(DEFAULT_DDR_V2_STORE_CONTRACTS);
    expect(first.ddrRunId).toMatch(/^ddr:quarter-hour:1780358400:[0-9a-f]{12}$/);
    expect(second.ddrRunId).not.toBe(first.ddrRunId);
  });

  it("preserves explicit false health, zero run time and caller identity without dropping cancellation", () => {
    const { db } = fixtures.open();
    const fallback = new AbortController().signal;
    const controller = new AbortController();
    controller.abort(new Error("cancel this run"));
    const contracts = { ...DEFAULT_DDR_V2_STORE_CONTRACTS };
    const normalized = normalizeComputeOptions({
      db, signal: controller.signal, runAt: 0, slot: "manual", ddrRunId: "operator-run",
      stablecoinsCacheSafe: false, depegPipelineHealthy: false,
      storeContracts: contracts,
    }, fallback);

    expect(normalized).toMatchObject({
      runAt: 0, slot: "manual", ddrRunId: "operator-run",
      stablecoinsCacheSafe: false, depegPipelineHealthy: false,
    });
    expect(normalized.signal).toBe(controller.signal);
    expect(normalized.signal?.aborted).toBe(true);
    expect(normalized.storeContracts).toBe(contracts);
    expect(normalizeComputeOptions({ db }, fallback).signal).toBe(fallback);
    expect(normalizeComputeOptions({ db, slot: "manual", runAt: 12 }).ddrRunId)
      .toMatch(/^ddr:manual:12:[0-9a-f]{12}$/);
  });
});
