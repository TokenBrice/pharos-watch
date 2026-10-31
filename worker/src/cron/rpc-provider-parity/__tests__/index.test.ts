import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCircuitRecord } from "../../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import type { CronResult, CronProgressReporter } from "../../../lib/cron-logger";
import type { RpcParityProbeRunResult } from "../probe";
import { readRpcParityStore, RPC_PARITY_STORE_KEY } from "../../../lib/rpc-provider-parity/store";
import { rpcParityCircuitOutcome, syncRpcProviderParity } from "../index";
import { RPC_PARITY_TARGETS } from "../../../lib/rpc-provider-parity/targets";
import { DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH } from "../../../lib/rpc-provider-budget";
import {
  fullParityRun,
  PARITY_NOW_SEC,
  paritySample,
} from "../../../lib/rpc-provider-parity/__tests__/rpc-parity-test-support";

const fixtures = createLatestSchemaFixtureTracker();
const API_KEY = "dwellir-parity-test-key";

afterEach(() => {
  fixtures.closeAll();
});

function probeResult(overrides: Partial<RpcParityProbeRunResult> = {}): RpcParityProbeRunResult {
  return {
    samples: [],
    attempted: 0,
    headOk: 0,
    deadlineHit: false,
    aborted: false,
    skipped: [],
    ...overrides,
  };
}

function metadataOf(result: CronResult | void): Record<string, unknown> {
  return JSON.parse(String(result?.metadata ?? "{}")) as Record<string, unknown>;
}

function currentMonthWindow(): { nowSec: number; month: string; ledgerKey: string } {
  const nowSec = Math.floor(Date.now() / 1000);
  const month = new Date(nowSec * 1000).toISOString().slice(0, 7);
  return { nowSec, month, ledgerKey: `rpc:dwellir:credits:v1:${month}` };
}

describe("rpc parity circuit verdict", () => {
  it("judges the provider by the attempted chains, not by the run", () => {
    expect(rpcParityCircuitOutcome(0, 0)).toBe("neutral");
    expect(rpcParityCircuitOutcome(10, 5)).toBe("success");
    expect(rpcParityCircuitOutcome(10, 4)).toBe("failure");
    expect(rpcParityCircuitOutcome(1, 1)).toBe("success");
  });
});

describe("rpc parity job", () => {
  it("skips the whole run when the key is absent, without touching the store or the circuit", async () => {
    const { db } = fixtures.open();
    const result = await syncRpcProviderParity(
      db,
      {},
      new AbortController().signal,
      undefined,
      { probe: async () => probeResult({ attempted: 1, headOk: 1 }) },
    );

    expect(result?.status).toBe("skipped_neutral");
    expect(result?.itemCount).toBe(0);
    expect(metadataOf(result)).toMatchObject({ skipped: true, reason: "not-configured", configured: false });
    const store = await readRpcParityStore(db);
    expect(store.row).toBeNull();
    expect(store.error).toBeNull();
    const circuit = await getCircuitRecord(db, CIRCUIT_SOURCE.DWELLIR_EVM);
    expect(circuit).toMatchObject({ state: "closed", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null });
  });

  it("skips when the monthly credit ledger is exhausted", async () => {
    const { db } = fixtures.open();
    const { nowSec, month, ledgerKey } = currentMonthWindow();
    await db.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(ledgerKey, JSON.stringify({ window: month, usedCredits: DWELLIR_DEFAULT_MAX_CREDITS_PER_MONTH }), nowSec)
      .run();

    let probed = false;
    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => { probed = true; return probeResult(); } },
    );

    expect(probed).toBe(false);
    expect(result?.status).toBe("skipped_neutral");
    expect(metadataOf(result)).toMatchObject({ reason: "provider-budget-exhausted", configured: true });
  });

  it("stores the run and closes the circuit when most chains answered", async () => {
    const { db } = fixtures.open();
    const samples = RPC_PARITY_TARGETS.slice(0, 4).map((target, index) => paritySample(
      target.chainId,
      { headOk: index < 3 },
    ));
    const progress: string[] = [];
    const reportProgress: CronProgressReporter = async (update) => {
      progress.push(String(update.stage));
    };

    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      reportProgress,
      { probe: async () => probeResult({ samples, attempted: 4, headOk: 3 }) },
    );

    expect(result?.status).toBe("ok");
    expect(result?.itemCount).toBe(4);
    expect(metadataOf(result)).toMatchObject({
      attempted: 4,
      headOk: 3,
      deadlineHit: false,
      truncated: false,
      aborted: false,
      rotation: {
        windowHours: 3, maxChainsPerRun: 14, targetCount: RPC_PARITY_TARGETS.length,
        selectedChains: expect.any(Array),
      },
      runsRetained: 1,
      circuit: "success",
      circuitRecorded: true,
    });
    const store = await readRpcParityStore(db);
    expect(store.row?.runs).toHaveLength(1);
    expect(store.row?.runs[0].samples.map((sample) => sample.chainId)).toEqual(
      RPC_PARITY_TARGETS.slice(0, 4).map((target) => target.chainId),
    );
    const circuit = await getCircuitRecord(db, CIRCUIT_SOURCE.DWELLIR_EVM);
    expect(circuit.state).toBe("closed");
    expect(circuit.consecutiveFailures).toBe(0);
    expect(progress).toContain("stored");
  });

  it("opens the circuit when fewer than half of the attempted chains answered", async () => {
    const { db } = fixtures.open();
    const samples = RPC_PARITY_TARGETS.slice(0, 4).map((target, index) => paritySample(
      target.chainId,
      { headOk: index < 1, errorClass: index < 1 ? null : "network" },
    ));

    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => probeResult({ samples, attempted: 4, headOk: 1 }) },
    );

    expect(metadataOf(result)).toMatchObject({ circuit: "failure", circuitRecorded: true });
    const circuit = await getCircuitRecord(db, CIRCUIT_SOURCE.DWELLIR_EVM);
    expect(circuit.consecutiveFailures).toBe(1);
    expect(circuit.lastFailureAt).toBeGreaterThan(0);
  });

  it("records nothing on the circuit when no chain was attempted", async () => {
    const { db } = fixtures.open();
    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => probeResult({ skipped: [{ chainId: "base", reason: "deadline" }], deadlineHit: true }) },
    );

    expect(result?.status).toBe("degraded");
    expect(metadataOf(result)).toMatchObject({
      attempted: 0,
      deadlineHit: true,
      truncated: true,
      reason: "rpc-parity-deadline-exhausted",
      outputPublishedAt: null,
      circuit: "neutral",
      circuitRecorded: false,
    });
    const circuit = await getCircuitRecord(db, CIRCUIT_SOURCE.DWELLIR_EVM);
    expect(circuit).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null });
    const store = await readRpcParityStore(db);
    expect(store.row?.runs[0].skipped).toEqual([{ chainId: "base", reason: "deadline" }]);
  });

  it("reports a bounded truncated observation as ok and retains incomplete coverage", async () => {
    const { db } = fixtures.open();
    const samples = [paritySample(RPC_PARITY_TARGETS[0].chainId)];
    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => probeResult({ samples, attempted: 1, headOk: 1, deadlineHit: true, skipped: [{ chainId: RPC_PARITY_TARGETS[1].chainId, reason: "deadline" }] }) },
    );

    expect(result?.status).toBe("ok");
    expect(result?.itemCount).toBe(1);
    const metadata = metadataOf(result);
    expect(metadata).toMatchObject({
      attempted: 1, headOk: 1, deadlineHit: true, truncated: true,
      skipped: 1, runsRetained: 1, circuit: "success",
      truncationReason: "rpc-parity-deadline-exhausted",
    });
    expect(metadata).not.toHaveProperty("reason");
    expect(metadata.outputPublishedAt).toBeGreaterThan(0);
    const store = await readRpcParityStore(db);
    expect(store.row?.runs).toHaveLength(1);
    expect(store.row?.runs[0].samples).toMatchObject([{ chainId: RPC_PARITY_TARGETS[0].chainId, headOk: true }]);
    expect(store.row?.runs[0].skipped).toEqual([{ chainId: RPC_PARITY_TARGETS[1].chainId, reason: "deadline" }]);
  });

  it.each([
    { attempted: 1, samples: [] },
    { attempted: 0, samples: [paritySample(RPC_PARITY_TARGETS[0].chainId)] },
  ])("does not accept deadline truncation without both attempt and sample evidence ($attempted attempts)", async ({ attempted, samples }) => {
    const { db } = fixtures.open();
    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => probeResult({ attempted, samples, deadlineHit: true }) },
    );

    expect(result?.status).toBe("degraded");
    expect(metadataOf(result)).toMatchObject({
      reason: "rpc-parity-deadline-exhausted", truncated: true, deadlineHit: true,
    });
  });

  it("keeps a returned probe abort degraded despite collected deadline samples", async () => {
    const { db } = fixtures.open();
    const samples = [paritySample(RPC_PARITY_TARGETS[0].chainId)];
    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => probeResult({ samples, attempted: 1, headOk: 1, deadlineHit: true, aborted: true }) },
    );

    expect(result?.status).toBe("degraded");
    expect(metadataOf(result)).toMatchObject({ reason: "rpc-parity-probe-aborted", truncated: true });
    const store = await readRpcParityStore(db);
    expect(store.row?.runs[0].samples).toMatchObject([{ chainId: RPC_PARITY_TARGETS[0].chainId, headOk: true }]);
  });

  it("leaves an open Dwellir circuit untouched when the job signal tears the run down", async () => {
    const { db } = fixtures.open();
    const openedAt = Math.floor(Date.now() / 1000) - 60;
    await db.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(
        `circuit:${CIRCUIT_SOURCE.DWELLIR_EVM}`,
        JSON.stringify({
          state: "open",
          consecutiveFailures: 3,
          lastFailureAt: openedAt,
          lastSuccessAt: null,
          openedAt,
        }),
        openedAt,
      )
      .run();

    const controller = new AbortController();
    await expect(syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      controller.signal,
      undefined,
      {
        probe: async () => {
          // One rotated chain finished before the deploy eviction fired the job
          // signal; the probe returns its partial samples marked aborted.
          controller.abort();
          return probeResult({
            samples: [paritySample(RPC_PARITY_TARGETS[0].chainId)],
            attempted: 1,
            headOk: 1,
            aborted: true,
          });
        },
      },
    )).rejects.toThrow();

    // A torn-down run is not provider evidence: it must not close the breaker
    // that admitted the provider on a full run's measured outcome.
    const circuit = await getCircuitRecord(db, CIRCUIT_SOURCE.DWELLIR_EVM);
    expect(circuit).toMatchObject({
      state: "open",
      consecutiveFailures: 3,
      lastFailureAt: openedAt,
      lastSuccessAt: null,
      openedAt,
    });
  });

  it("keeps store degradation actionable despite a sampled deadline run", async () => {
    const { db } = fixtures.open();
    await db.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(RPC_PARITY_STORE_KEY, "unreadable parity payload", PARITY_NOW_SEC)
      .run();
    const samples = [paritySample(RPC_PARITY_TARGETS[0].chainId)];
    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => probeResult({ samples, attempted: 1, headOk: 1, deadlineHit: true }) },
    );

    expect(result?.status).toBe("degraded");
    expect(metadataOf(result)).toMatchObject({
      reason: "rpc-parity-store-degraded", truncated: true,
      storeError: `unreadable ${RPC_PARITY_STORE_KEY} payload`,
    });
    const store = await readRpcParityStore(db);
    expect(store.error).toBeNull();
    expect(store.row?.runs[0].samples).toMatchObject([{ chainId: RPC_PARITY_TARGETS[0].chainId, headOk: true }]);
  });

  it("returns an error result instead of throwing when the probe itself fails", async () => {
    const { db } = fixtures.open();
    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => { throw new Error("registry unavailable"); } },
    );

    expect(result?.status).toBe("error");
    expect(result?.error).toContain("registry unavailable");
    const store = await readRpcParityStore(db);
    expect(store.row).toBeNull();
  });

  it("rethrows the job abort so the slot fence owns the outcome", async () => {
    const { db } = fixtures.open();
    const controller = new AbortController();
    const samples = fullParityRun(PARITY_NOW_SEC).samples.slice(0, 2);
    controller.abort();
    await expect(syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      controller.signal,
      undefined,
      { probe: async () => probeResult({ samples, attempted: 2, headOk: 2, aborted: true }) },
    )).rejects.toThrow();
  });
});
