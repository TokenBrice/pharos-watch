import { gunzipSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCache } from "../../db-cache";
import { RPC_PARITY_TARGETS } from "../targets";
import { RPC_PARITY_MAX_CALLS_PER_OPERATOR } from "../types";
import {
  decodeRpcParityStoreRow,
  encodeRpcParityStoreRow,
  mergeRpcParityRun,
  readRpcParityStore,
  recordRpcParityRun,
  RPC_PARITY_MAX_ROW_BYTES,
  RPC_PARITY_RETENTION_RUNS,
  RPC_PARITY_RETENTION_SEC,
  RPC_PARITY_STORE_KEY,
  type RpcParityStoreRow,
} from "../store";
import {
  buildParityRow,
  fullParityRun,
  PARITY_NOW_SEC as NOW_SEC,
  paritySample,
  stepFailures,
} from "./rpc-parity-test-support";

const fixtures = createLatestSchemaFixtureTracker();
const WEEK_SEC = RPC_PARITY_RETENTION_SEC;

function storedWire(value: string): unknown {
  const envelope = JSON.parse(value) as { payload?: string };
  if (!envelope.payload) return envelope;
  const bytes = gunzipSync(Buffer.from(envelope.payload, "base64"));
  return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
}

afterEach(() => {
  fixtures.closeAll();
});

describe("rpc parity store merging", () => {
  it("retains seven days of runs in order and replaces a duplicate slot", () => {
    const first = mergeRpcParityRun(null, fullParityRun(NOW_SEC - 2 * 3600), { nowSec: NOW_SEC - 2 * 3600 });
    expect(first.row.chains).toEqual(RPC_PARITY_TARGETS.map((target) => target.chainId));
    expect(first.reset).toBe(false);

    const second = mergeRpcParityRun(first.row, fullParityRun(NOW_SEC - 3600), { nowSec: NOW_SEC - 3600 });
    const third = mergeRpcParityRun(second.row, fullParityRun(NOW_SEC), { nowSec: NOW_SEC });
    expect(third.row.runs.map((run) => run.atSec)).toEqual([NOW_SEC - 2 * 3600, NOW_SEC - 3600, NOW_SEC]);

    const replaced = mergeRpcParityRun(third.row, fullParityRun(NOW_SEC, () => ({ dwellirHead: 1 })), { nowSec: NOW_SEC });
    expect(replaced.row.runs.map((run) => run.atSec)).toEqual([NOW_SEC - 2 * 3600, NOW_SEC - 3600, NOW_SEC]);
    expect(replaced.row.runs[2].samples).toHaveLength(RPC_PARITY_TARGETS.length);
    expect(replaced.row.runs[2].samples[0].dwellirHead).toBe(1);

    const stale = mergeRpcParityRun(third.row, fullParityRun(NOW_SEC + WEEK_SEC + 1), { nowSec: NOW_SEC + WEEK_SEC + 1 });
    expect(stale.row.runs.map((run) => run.atSec)).toEqual([NOW_SEC + WEEK_SEC + 1]);
  });

  it("caps the window at the retained-run count", () => {
    let row: RpcParityStoreRow | null = null;
    for (let index = 0; index < RPC_PARITY_RETENTION_RUNS + 5; index += 1) {
      const atSec = NOW_SEC + index * 3600;
      row = mergeRpcParityRun(row, fullParityRun(atSec), { nowSec: atSec }).row;
    }
    expect(row?.runs).toHaveLength(RPC_PARITY_RETENTION_RUNS);
    expect(row?.runs[0].atSec).toBe(NOW_SEC + 5 * 3600);
  });

  it("keeps the serialized window well under the cache-row budget", () => {
    const row = buildParityRow(
      Array.from({ length: RPC_PARITY_RETENTION_RUNS }, (_, index) => NOW_SEC - (RPC_PARITY_RETENTION_RUNS - 1 - index) * 3600),
    );
    const bytes = encodeRpcParityStoreRow(row).length;
    expect(row.runs).toHaveLength(RPC_PARITY_RETENTION_RUNS);
    expect(bytes).toBeLessThan(RPC_PARITY_MAX_ROW_BYTES);
    expect(bytes).toBeLessThan(256 * 1024);
  });

  it("drops the oldest runs, never the newest, when the row exceeds the size bound", () => {
    let row: RpcParityStoreRow | null = null;
    const atSecs: number[] = [];
    for (let index = 0; index < 12; index += 1) {
      const atSec = NOW_SEC + index * 3600;
      atSecs.push(atSec);
      row = mergeRpcParityRun(row, fullParityRun(atSec), { nowSec: atSec, maxBytes: 1_000 }).row;
    }
    if (!row) throw new Error("row not built");
    expect(row.runs.length).toBeGreaterThanOrEqual(1);
    expect(row.runs.length).toBeLessThan(atSecs.length);
    expect(row.runs[row.runs.length - 1].atSec).toBe(atSecs[atSecs.length - 1]);
    const retained = row.runs.map((run) => run.atSec);
    expect(retained).toEqual(atSecs.slice(atSecs.length - retained.length));
  });

  it("resets the window when the target table is reordered, and keeps appends attributable", () => {
    const rows = buildParityRow([NOW_SEC - 3600, NOW_SEC]);
    const reordered: RpcParityStoreRow = { ...rows, chains: [...rows.chains].reverse() };
    const reset = mergeRpcParityRun(reordered, fullParityRun(NOW_SEC + 3600), { nowSec: NOW_SEC + 3600 });
    expect(reset.reset).toBe(true);
    expect(reset.row.runs.map((run) => run.atSec)).toEqual([NOW_SEC + 3600]);

    // A row written before a chain was appended keeps its own index map, so its
    // samples still decode to the chains they were measured on.
    const prefix: RpcParityStoreRow = {
      ...rows,
      chains: rows.chains.slice(0, 3),
      runs: rows.runs.map((run) => ({ atSec: run.atSec, samples: run.samples.slice(0, 3) })),
    };
    const grown = mergeRpcParityRun(prefix, fullParityRun(NOW_SEC + 3600), { nowSec: NOW_SEC + 3600 });
    expect(grown.reset).toBe(false);
    expect(grown.row.chains).toEqual(RPC_PARITY_TARGETS.map((target) => target.chainId));
    const decoded = decodeRpcParityStoreRow(encodeRpcParityStoreRow(grown.row));
    const olderRun = decoded?.runs.find((run) => run.atSec === NOW_SEC);
    expect(olderRun?.samples.map((entry) => entry.chainId)).toEqual(prefix.chains);
  });
});

describe("rpc parity store wire form", () => {
  it("round-trips every stored field", () => {
    const run = {
      atSec: NOW_SEC,
      samples: [
        paritySample("base", { errorClass: "capability", headOk: false, stateChecked: false, stateMatched: false, logChecked: false, logMatched: false, commonBlock: null, lagBlocks: null, dwellirLatencyMs: null }),
        paritySample("zksync", { prunedLogChecked: true, prunedLogTrap: true, logChecked: false, logMatched: false, comparator: { operator: "public", host: "mainnet.era.zksync.io", source: "pin" }, dwellirHost: "api-zksync-era-mainnet-full.n.dwellir.com" }),
      ],
    };
    const merged = mergeRpcParityRun(null, run, { nowSec: NOW_SEC });
    const decoded = decodeRpcParityStoreRow(encodeRpcParityStoreRow(merged.row));
    expect(decoded).not.toBeNull();
    const samples = decoded?.runs[0].samples ?? [];
    expect(samples).toHaveLength(2);
    expect(samples[0]).toMatchObject({
      chainId: "base",
      comparator: { operator: "public", host: "mainnet.base.org", source: "registry" },
      headOk: false,
      comparatorHeadOk: true,
      commonBlock: null,
      lagBlocks: null,
      dwellirLatencyMs: null,
      errorClass: "capability",
      stateChecked: false,
      logChecked: false,
    });
    expect(samples[1]).toMatchObject({
      chainId: "zksync",
      comparator: { operator: "public", host: "mainnet.era.zksync.io", source: "pin" },
      dwellirHost: "api-zksync-era-mainnet-full.n.dwellir.com",
      prunedLogChecked: true,
      prunedLogTrap: true,
      logChecked: false,
      comparatorLatencyMs: 1_000,
    });
    expect(decoded?.latest.base).toEqual({
      atSec: NOW_SEC,
      dwellirHead: 380_000_000,
      comparatorHead: 380_000_002,
      // The refused chain never reached a comparable block, so the latest
      // observation records no height to read.
      commonBlock: null,
    });
  });

  it("stores failure diagnostics sparsely and reads them back", () => {
    const run = {
      atSec: NOW_SEC,
      samples: [
        // A healthy chain: no diagnostics entry at all.
        paritySample("base"),
        paritySample("robinhood", {
          headOk: true,
          comparatorHeadOk: false,
          comparatorHead: null,
          lagBlocks: null,
          comparatorErrorClass: "capability",
          comparatorHttpStatus: 403,
          failedSteps: { dwellir: stepFailures(), comparator: stepFailures({ head: true }) },
        }),
        paritySample("arc", {
          comparatorErrorClass: "server-error",
          comparatorHttpStatus: 502,
          failedSteps: { dwellir: stepFailures({ logs: true }), comparator: stepFailures({ state: true, logs: true }) },
        }),
      ],
    };
    const merged = mergeRpcParityRun(null, run, { nowSec: NOW_SEC });

    const decoded = decodeRpcParityStoreRow(encodeRpcParityStoreRow(merged.row));
    const samples = decoded?.runs[0].samples ?? [];
    expect(samples[0].failedSteps).toEqual({
      dwellir: { head: false, state: false, logs: false, latest: false },
      comparator: { head: false, state: false, logs: false, latest: false },
    });
    expect(samples[0].comparatorErrorClass).toBeNull();
    expect(samples[0].comparatorHttpStatus).toBeNull();
    expect(samples[1]).toMatchObject({
      chainId: "robinhood",
      comparatorErrorClass: "capability",
      comparatorHttpStatus: 403,
      failedSteps: { dwellir: { head: false, state: false, logs: false }, comparator: { head: true, state: false, logs: false } },
    });
    expect(samples[2]).toMatchObject({
      chainId: "arc",
      comparatorErrorClass: "server-error",
      comparatorHttpStatus: 502,
      failedSteps: { dwellir: { head: false, state: false, logs: true }, comparator: { head: false, state: true, logs: true } },
    });
  });

  it("reads rows written before the diagnostics section existed", () => {
    // Literal pre-change wire shape: no third run element, no diagnostics.
    const legacy = JSON.stringify({
      v: 1,
      chains: ["base"],
      comparators: [["alchemy", "base-mainnet.g.alchemy.com", "registry"]],
      hosts: ["api-base-mainnet-archive.n.dwellir.com"],
      runs: [[NOW_SEC, `0|63|${(380_000_000).toString(36)}|1|412|398|0|0|0`]],
      latest: { base: [NOW_SEC, 380_000_000, 380_000_002, 379_999_000] },
    });
    const decoded = decodeRpcParityStoreRow(legacy);
    expect(decoded).not.toBeNull();
    const [sample] = decoded?.runs[0].samples ?? [];
    expect(sample).toMatchObject({
      chainId: "base",
      headOk: true,
      comparatorHeadOk: true,
      lagBlocks: 1,
      commonBlock: 380_000_000,
      dwellirLatencyMs: 412,
      comparatorLatencyMs: 398,
      errorClass: null,
    });
    expect(sample.comparatorErrorClass).toBeNull();
    expect(sample.comparatorHttpStatus).toBeNull();
    expect(sample.failedSteps).toEqual({
      dwellir: { head: false, state: false, logs: false, latest: false },
      comparator: { head: false, state: false, logs: false, latest: false },
    });
    expect(sample.calls).toBeUndefined();
    expect(sample.latestFreshness).toBeUndefined();
    expect(decoded?.latest.base).toEqual({
      atSec: NOW_SEC,
      dwellirHead: 380_000_000,
      comparatorHead: 380_000_002,
      commonBlock: 379_999_000,
    });
  });
  it("reads v2 telemetry without fabricating discriminating freshness or skip reasons", () => {
    const legacy = JSON.stringify({
      v: 2, chains: ["base"],
      comparators: [["public", "mainnet.base.org", "registry"]],
      hosts: ["api-base-mainnet-archive.n.dwellir.com"],
      layouts: [[[0], [0]]],
      runs: [[NOW_SEC, `0|63|2s|0|||0|0|0|${JSON.stringify([0, [100, 100], [0, 0, 0, 0, 0]])}`]],
      latest: { base: [NOW_SEC, 100, 100, 100] },
    });
    const decoded = decodeRpcParityStoreRow(legacy);
    expect(decoded?.runs[0].samples[0].latestFreshness).toEqual({
      verdict: "fresh", reason: "matched-numeric-block", headBefore: 100, headAfter: 100, matchedBlock: 100,
    });
    expect(decoded?.runs[0].skipped).toBeUndefined();
    const rewritten = decodeRpcParityStoreRow(encodeRpcParityStoreRow(decoded!));
    expect(rewritten?.runs[0].samples[0].latestFreshness?.discriminating).toBeUndefined();
    expect(rewritten?.runs[0].skipped).toBeUndefined();
  });

  it.each([
    { code: 0, fields: [0, 5, 0, 0, null, null, null, 0, true, 0, 0, 2], method: "multicall3-block-number" },
    { code: 1, fields: [0, 0, 0, 0, 0, null, null, 1, false, null, null, 0], method: "state-bracket" },
  ])("preserves pre-ArbSys v3 method code $code", ({ fields, method }) => {
    const legacy = JSON.stringify({
      v: 3, chains: ["base"],
      comparators: [["public", "mainnet.base.org", "registry"]],
      hosts: ["api-base-mainnet-archive.n.dwellir.com"], layouts: [[[0], [0]]],
      runs: [[NOW_SEC, `0|63|2s|0|||0|0|0|${JSON.stringify([0, [100, 100], fields])}`]],
      latest: { base: [NOW_SEC, 100, 100, 100] },
    });
    expect(decodeRpcParityStoreRow(legacy)?.runs[0].samples[0].latestFreshness?.method).toBe(method);
  });

  it("preserves split comparator provenance, including the log-origin warm-up head", () => {
    const stateRef = { operator: "public" as const, host: "hyperliquid.drpc.org", source: "pin" as const };
    const logRef = { operator: "alchemy" as const, host: "hyperliquid-mainnet.g.alchemy.com", source: "pin" as const };
    const sample = paritySample("hyperevm", {
      comparator: stateRef, logsComparator: logRef,
      calls: {
        dwellir: [{ step: "head", phase: "firstTouch", latencyMs: 100, errorClass: null }],
        comparator: [
          { step: "head", phase: "firstTouch", latencyMs: 110, errorClass: null },
          { step: "state", phase: "warm", latencyMs: 50, errorClass: null },
          { step: "head", phase: "firstTouch", latencyMs: 120, errorClass: null, comparator: logRef },
          { step: "logs", phase: "warm", latencyMs: 60, errorClass: null, comparator: logRef },
        ],
      },
    });
    const row = mergeRpcParityRun(null, { atSec: NOW_SEC, samples: [sample] }, { nowSec: NOW_SEC }).row;
    const decoded = decodeRpcParityStoreRow(encodeRpcParityStoreRow(row))?.runs[0].samples[0];
    expect(decoded?.comparator).toEqual(stateRef);
    expect(decoded?.logsComparator).toEqual(logRef);
    expect(decoded?.calls).toEqual(sample.calls);
  });

  it("preserves an unavailable log comparator and rejects positive log flags without it", () => {
    const sample = paritySample("hyperevm", {
      logsComparator: null, logChecked: false, logMatched: false,
      calls: { dwellir: [], comparator: [] },
    });
    const row = mergeRpcParityRun(null, { atSec: NOW_SEC, samples: [sample] }, { nowSec: NOW_SEC }).row;
    const encoded = encodeRpcParityStoreRow(row);
    expect(decodeRpcParityStoreRow(encoded)?.runs[0].samples[0].logsComparator).toBeNull();
    sample.logChecked = true;
    expect(decodeRpcParityStoreRow(encodeRpcParityStoreRow({
      ...row, runs: [{ atSec: NOW_SEC, samples: [sample] }],
    }))).toBeNull();
  });

  it("round-trips skip-only runs with their machine-readable reasons", () => {
    const skipped = [{ chainId: "base", reason: "deadline" as const }, { chainId: "astar", reason: "no-comparator" as const }];
    const row = mergeRpcParityRun(null, { atSec: NOW_SEC, samples: [], skipped }, { nowSec: NOW_SEC }).row;
    expect(decodeRpcParityStoreRow(encodeRpcParityStoreRow(row))?.runs[0].skipped).toEqual(skipped);
  });

  it("uses the same encoder and decoder bound for a maximum fallback layout", () => {
    const calls = {
      dwellir: Array.from({ length: RPC_PARITY_MAX_CALLS_PER_OPERATOR.dwellir }, () => ({
        step: "latest" as const, phase: "warm" as const, latencyMs: 1, errorClass: null,
      })),
      comparator: [],
    };
    const row = mergeRpcParityRun(null, { atSec: NOW_SEC, samples: [paritySample("xdc", { calls })] }, { nowSec: NOW_SEC }).row;
    expect(decodeRpcParityStoreRow(encodeRpcParityStoreRow(row))?.runs[0].samples[0].calls).toEqual(calls);
    calls.dwellir.push({ step: "latest", phase: "warm", latencyMs: 1, errorClass: null });
    expect(() => encodeRpcParityStoreRow(row)).toThrow("rpc-parity-call-bound:dwellir");
  });


  it("preserves per-call timings and the newest stale example through compression", () => {
    const freshness = {
      verdict: "stale" as const, reason: "no-bracket-match" as const,
      headBefore: 100, headAfter: 101, matchedBlock: null, latestValue: "1000",
      numericValues: [{ block: 101, value: "1001" }, { block: 100, value: "1001" }],
    };
    const sample = paritySample("base", {
      commonBlock: 98,
      calls: {
        dwellir: [
          { step: "head", phase: "firstTouch", latencyMs: 0, errorClass: null },
          { step: "latest", phase: "warm", latencyMs: 8_001, errorClass: "timeout" },
          { step: "state", phase: "warm", latencyMs: 90_000, errorClass: null },
        ],
        comparator: [{ step: "head", phase: "firstTouch", latencyMs: 10.5, errorClass: null }],
      },
      latestFreshness: freshness,
    });
    const row = mergeRpcParityRun(null, { atSec: NOW_SEC, samples: [sample] }, { nowSec: NOW_SEC }).row;
    const decoded = decodeRpcParityStoreRow(encodeRpcParityStoreRow(row));
    expect(decoded?.runs[0].samples[0].calls).toEqual(sample.calls);
    expect(decoded?.runs[0].samples[0].latestFreshness).toEqual(freshness);
    expect(decoded?.runs[0].samples[0].commonBlock).toBe(98);
  });

  it.each(["multicall3-block-number", "arbsys-block-number"] as const)("retains recorded %s budget/stale evidence and only the newest value", (method) => {
    const freshness = {
      verdict: "stale" as const, reason: "served-block-behind" as const, method,
      discriminating: true, headBefore: 100, headAfter: 100, matchedBlock: null,
      servedBlock: 97, lagBlocks: 3, toleranceBlocks: 2, latestValue: "97", numericValues: [],
    };
    let row = mergeRpcParityRun(null, {
      atSec: NOW_SEC - 3600, samples: [paritySample("base", { commonBlock: 98, latestFreshness: freshness })],
    }, { nowSec: NOW_SEC - 3600 }).row;
    row = mergeRpcParityRun(row, {
      atSec: NOW_SEC, samples: [paritySample("base", { commonBlock: 98, latestFreshness: freshness })],
    }, { nowSec: NOW_SEC }).row;
    const decoded = decodeRpcParityStoreRow(encodeRpcParityStoreRow(row));
    expect(decoded?.runs[0].samples[0].latestFreshness).toMatchObject({
      method, servedBlock: 97, lagBlocks: 3, discriminating: true, toleranceBlocks: 2,
    });
    expect(decoded?.runs[0].samples[0].latestFreshness?.latestValue).toBeUndefined();
    expect(decoded?.runs[1].samples[0].latestFreshness).toEqual(freshness);
  });

  it("fits the verified 36 sentinel chains and one maximum fallback chain by 168 runs", () => {
    let seed = 1_234_567;
    const latency = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed % 8_001;
    };
    const runs = Array.from({ length: RPC_PARITY_RETENTION_RUNS }, (_, index) => fullParityRun(
      NOW_SEC - (RPC_PARITY_RETENTION_RUNS - 1 - index) * 3600,
      (chainId, chainIndex) => ({
        commonBlock: 380_000_000 + index * 3600 + chainIndex * 1000,
        ...(chainId === "hyperevm" ? {
          comparator: { operator: "public" as const, host: "hyperliquid.drpc.org", source: "pin" as const },
          logsComparator: { operator: "alchemy" as const, host: "hyperliquid-mainnet.g.alchemy.com", source: "pin" as const },
        } : {}),
        calls: {
          dwellir: (chainId === "xdc"
            ? ["head", "latest", "latest", "head", "latest", "latest", "latest", "latest", "latest", "latest", "state", "logs"]
            : ["head", "state", "logs", "latest", "head"]).map((step, callIndex) => ({
            step: step as "head" | "latest" | "state" | "logs",
            phase: callIndex === 0 ? "firstTouch" as const : "warm" as const,
            latencyMs: latency(), errorClass: null,
          })),
          comparator: (chainId === "hyperevm" ? ["head", "state", "head", "logs"] : ["head", "state", "logs"]).map((step, callIndex) => ({
            step: step as "head" | "state" | "logs",
            phase: callIndex === 0 || (chainId === "hyperevm" && callIndex === 2) ? "firstTouch" as const : "warm" as const,
            latencyMs: latency(), errorClass: null,
            ...(chainId === "hyperevm" && callIndex >= 2 ? {
              comparator: { operator: "alchemy" as const, host: "hyperliquid-mainnet.g.alchemy.com", source: "pin" as const },
            } : {}),
          })),
        },
      }),
    ));
    const row = {
      chains: RPC_PARITY_TARGETS.map((target) => target.chainId),
      comparators: [], dwellirHosts: [], runs, latest: {},
    };
    expect(row.chains).toHaveLength(37);
    expect(encodeRpcParityStoreRow(row).length).toBeLessThan(RPC_PARITY_MAX_ROW_BYTES);
    const decoded = decodeRpcParityStoreRow(encodeRpcParityStoreRow(row));
    expect(decoded?.runs).toHaveLength(168);
    expect(decoded?.runs[167].samples[36].calls).toEqual(runs[167].samples[36].calls);
  });

  it("rejects payloads it cannot trust", () => {
    expect(decodeRpcParityStoreRow("not json")).toBeNull();
    expect(decodeRpcParityStoreRow(JSON.stringify({ v: 2 }))).toBeNull();
    const row = buildParityRow([NOW_SEC]);
    const wire = storedWire(encodeRpcParityStoreRow(row)) as { runs: [number, string][] };
    wire.runs[0][1] = "0|1|2";
    expect(decodeRpcParityStoreRow(JSON.stringify(wire))).toBeNull();
  });
});

describe("rpc parity store persistence", () => {
  it("reports a missing row without an error", async () => {
    const { db } = fixtures.open();
    await expect(readRpcParityStore(db)).resolves.toEqual({ row: null, updatedAtSec: null, error: null });
  });

  it("writes and reads back a run", async () => {
    const { db } = fixtures.open();
    const write = await recordRpcParityRun(db, fullParityRun(NOW_SEC));
    expect(write.ok).toBe(true);
    expect(write.runs).toBe(1);
    expect(write.bytes).toBeLessThan(RPC_PARITY_MAX_ROW_BYTES);

    const read = await readRpcParityStore(db);
    expect(read.error).toBeNull();
    expect(read.row?.runs).toHaveLength(1);
    expect(read.row?.runs[0].samples).toHaveLength(RPC_PARITY_TARGETS.length);
    const cached = await getCache(db, RPC_PARITY_STORE_KEY);
    expect(cached?.value.length).toBe(write.bytes);
  });

  it("surfaces an unreadable payload as an error instead of throwing", async () => {
    const { db } = fixtures.open();
    await db.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .bind(RPC_PARITY_STORE_KEY, "{not-a-row", NOW_SEC)
      .run();
    const read = await readRpcParityStore(db);
    expect(read.row).toBeNull();
    expect(read.updatedAtSec).toBe(NOW_SEC);
    expect(read.error).toContain(RPC_PARITY_STORE_KEY);
  });
});
