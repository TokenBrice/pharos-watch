import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCircuitRecord } from "../../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../../lib/constants";
import type { CronResult, CronProgressReporter } from "../../../lib/cron-logger";
import type { RpcParityProbeRunResult } from "../probe";
import { readRpcParityStore } from "../../../lib/rpc-provider-parity/store";
import { rpcParityCircuitOutcome, syncRpcProviderParity } from "../index";
import { RPC_PARITY_TARGETS } from "../../../lib/rpc-provider-parity/targets";
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
      .bind(ledgerKey, JSON.stringify({ window: month, usedCredits: 20_000_000 }), nowSec)
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
      aborted: false,
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
    expect(metadataOf(result)).toMatchObject({ circuit: "neutral", circuitRecorded: false });
    const circuit = await getCircuitRecord(db, CIRCUIT_SOURCE.DWELLIR_EVM);
    expect(circuit).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null });
  });

  it("reports a truncated run as degraded and still stores what was measured", async () => {
    const { db } = fixtures.open();
    const samples = [paritySample(RPC_PARITY_TARGETS[0].chainId)];
    const result = await syncRpcProviderParity(
      db,
      { DWELLIR_API_KEY: API_KEY },
      new AbortController().signal,
      undefined,
      { probe: async () => probeResult({ samples, attempted: 1, headOk: 1, deadlineHit: true, skipped: [{ chainId: RPC_PARITY_TARGETS[1].chainId, reason: "deadline" }] }) },
    );

    expect(result?.status).toBe("degraded");
    expect(metadataOf(result)).toMatchObject({ attempted: 1, headOk: 1, deadlineHit: true, skipped: 1, runsRetained: 1 });
    const store = await readRpcParityStore(db);
    expect(store.row?.runs).toHaveLength(1);
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
