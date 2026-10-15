import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { applyRpcParityGateHistory, captureRpcParityGateRun, isRpcParityGateRun } from "../gate-history";
import { buildRpcParityChainSummary, evaluateRpcParityGate } from "../report";
import { decodeRpcParityStoreRow, encodeRpcParityStoreRow, mergeRpcParityRun, RPC_PARITY_RETENTION_SEC } from "../store";
import type { RpcParityStoreRow } from "../store";
import { fullParityRun, paritySample, PARITY_NOW_SEC } from "./rpc-parity-test-support";

function summaryFor(row: RpcParityStoreRow) {
  return buildRpcParityChainSummary({
    chainId: "base", runs: row.runs, gateRuns: row.gateRuns, latest: row.latest.base ?? null,
    dwellirHost: paritySample("base").dwellirHost, fallbackComparator: paritySample("base").comparator,
    logsHistoryIsNone: false, blockTimeSec: 2,
  });
}

describe("independently retained parity gate history", () => {
  it("keeps negative evidence after the exact detailed byte boundary prunes its run", () => {
    const first = mergeRpcParityRun(null, fullParityRun(PARITY_NOW_SEC - 3600, (chain) => chain === "base" ? {
      stateMatched: false, logMatched: false,
      calls: {
        dwellir: [{ step: "head", phase: "firstTouch", latencyMs: 1, errorClass: "timeout" }], comparator: [],
      },
    } : {}), { nowSec: PARITY_NOW_SEC - 3600 });
    const second = mergeRpcParityRun(first.row, fullParityRun(PARITY_NOW_SEC), { nowSec: PARITY_NOW_SEC });
    const exact = mergeRpcParityRun(first.row, fullParityRun(PARITY_NOW_SEC), { nowSec: PARITY_NOW_SEC, maxBytes: second.bytes });
    expect(exact.row.runs).toHaveLength(2);
    const pruned = mergeRpcParityRun(first.row, fullParityRun(PARITY_NOW_SEC), { nowSec: PARITY_NOW_SEC, maxBytes: second.bytes - 1 });
    expect(pruned.row.runs).toHaveLength(1);
    const decoded = decodeRpcParityStoreRow(encodeRpcParityStoreRow(pruned.row));
    expect(decoded?.gateRuns).toHaveLength(2);
    const summary = summaryFor(decoded!);
    expect(summary.windowStartSec).toBe(PARITY_NOW_SEC);
    expect(summary.windowDurationSec).toBe(0);
    expect(summary.gateWindow).toEqual({ windowStartSec: PARITY_NOW_SEC - 3600, windowEndSec: PARITY_NOW_SEC, windowDurationSec: 3600, runs: 2 });
    expect(summary.stateParity).toMatchObject({ checked: 2, mismatched: 1, lastMismatch: { atSec: PARITY_NOW_SEC - 3600 } });
    expect(summary.logParity.mismatched).toBe(1);
    expect(summary.availability.dwellir.head.attempts).toBeGreaterThan(1);
    expect(summary.availability.dwellir.head.successRate).toBeLessThan(1);
    expect(summary.gate.failing).toEqual(expect.arrayContaining(["state-parity", "log-parity", "success-rate:head"]));
  });

  it("preserves stale identity and both freshness counters without fabricating timings or token values", () => {
    const sample = paritySample("base");
    const stale = { ...sample.sentinelFreshness!, verdict: "stale" as const, reason: "served-block-behind" as const,
      servedBlock: sample.sentinelFreshness!.headBefore! - 10, lagBlocks: 10, latestValue: "123", numericValues: [] };
    sample.sentinelFreshness = stale;
    sample.latestFreshness = stale;
    const run = captureRpcParityGateRun(PARITY_NOW_SEC - 3600, [sample]);
    expect(isRpcParityGateRun(run)).toBe(true);
    expect(run[1][0][7]).not.toHaveProperty("latestValue");
    expect(run[1][0][7]).not.toHaveProperty("numericValues");
    const row = mergeRpcParityRun(null, fullParityRun(PARITY_NOW_SEC), { nowSec: PARITY_NOW_SEC }).row;
    const summary = summaryFor(row);
    const latency = structuredClone(summary.latency);
    applyRpcParityGateHistory(summary, [run, captureRpcParityGateRun(PARITY_NOW_SEC, row.runs[0].samples)]);
    expect(summary.latestFreshness.stale).toBe(1);
    expect(summary.latestFreshness.sentinel.stale).toBe(1);
    expect(summary.latestFreshness.tokenState.fresh).toBe(2);
    expect(summary.latestFreshness.lastStale).toMatchObject({ atSec: PARITY_NOW_SEC - 3600, reason: "served-block-behind", call: stale.call });
    expect(summary.latency).toEqual(latency);
    expect(evaluateRpcParityGate(summary, 2).failing).toContain("latest-state-freshness");
  });

  it("retains the exact seven-day cutoff, expires one second beyond it, and replaces duplicate counters", () => {
    const firstAt = PARITY_NOW_SEC - RPC_PARITY_RETENTION_SEC;
    const first = mergeRpcParityRun(null, fullParityRun(firstAt, () => ({ stateMatched: false })), { nowSec: firstAt });
    const boundary = mergeRpcParityRun(first.row, fullParityRun(PARITY_NOW_SEC), { nowSec: PARITY_NOW_SEC });
    expect(boundary.row.gateRuns?.map(([atSec]) => atSec)).toEqual([firstAt, PARITY_NOW_SEC]);
    expect(summaryFor(boundary.row).stateParity.mismatched).toBe(1);
    const replaced = mergeRpcParityRun(boundary.row, fullParityRun(PARITY_NOW_SEC, () => ({ logMatched: false })), { nowSec: PARITY_NOW_SEC });
    expect(replaced.row.gateRuns).toHaveLength(2);
    expect(summaryFor(replaced.row).logParity.mismatched).toBe(1);
    const expired = mergeRpcParityRun(replaced.row, fullParityRun(PARITY_NOW_SEC + 1), { nowSec: PARITY_NOW_SEC + 1 });
    expect(expired.row.gateRuns?.map(([atSec]) => atSec)).toEqual([PARITY_NOW_SEC, PARITY_NOW_SEC + 1]);
    expect(summaryFor(expired.row).stateParity.mismatched).toBe(0);
  });

  it("resets only the changed host's counters and does not mutate the old row", () => {
    const first = mergeRpcParityRun(null, fullParityRun(PARITY_NOW_SEC - 3600, () => ({ stateMatched: false })), { nowSec: PARITY_NOW_SEC - 3600 });
    const before = structuredClone(first.row.gateRuns);
    const second = mergeRpcParityRun(first.row, fullParityRun(PARITY_NOW_SEC, (chain) => chain === "base" ? { dwellirHost: "new-base.n.dwellir.com" } : {}), { nowSec: PARITY_NOW_SEC });
    expect(second.row.gateRuns?.[0][1].some(([chain]) => chain === "base")).toBe(false);
    expect(second.row.gateRuns?.[0][1].some(([chain]) => chain === "arc")).toBe(true);
    expect(first.row.gateRuns).toEqual(before);
  });

  it("reads v6 evidence without inventing discarded history and rejects damaged v7 counters", () => {
    const row = mergeRpcParityRun(null, fullParityRun(PARITY_NOW_SEC), { nowSec: PARITY_NOW_SEC }).row;
    const envelope = JSON.parse(encodeRpcParityStoreRow(row));
    const wire = JSON.parse(gunzipSync(Buffer.from(envelope.payload, "base64")).toString());
    const legacy = { ...wire, v: 6 };
    delete legacy.gateRuns;
    expect(decodeRpcParityStoreRow(JSON.stringify(legacy))?.gateRuns).toEqual(row.gateRuns);
    expect(decodeRpcParityStoreRow(JSON.stringify({ ...wire, gateRuns: undefined }))).toBeNull();
    wire.gateRuns[0][1][0][5][0] = [1, 2, 0, 0];
    expect(decodeRpcParityStoreRow(JSON.stringify(wire))).toBeNull();
  });
});
