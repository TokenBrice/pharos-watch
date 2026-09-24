import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { getCache } from "../../db-cache";
import { RPC_PARITY_TARGETS } from "../targets";
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
} from "./rpc-parity-test-support";

const fixtures = createLatestSchemaFixtureTracker();
const WEEK_SEC = RPC_PARITY_RETENTION_SEC;

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
      row = mergeRpcParityRun(row, fullParityRun(atSec), { nowSec: atSec, maxBytes: 4_000 }).row;
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

  it("rejects payloads it cannot trust", () => {
    expect(decodeRpcParityStoreRow("not json")).toBeNull();
    expect(decodeRpcParityStoreRow(JSON.stringify({ v: 2 }))).toBeNull();
    const row = buildParityRow([NOW_SEC]);
    const wire = JSON.parse(encodeRpcParityStoreRow(row)) as { runs: [number, string][] };
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
