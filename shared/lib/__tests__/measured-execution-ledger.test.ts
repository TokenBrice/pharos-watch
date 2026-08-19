import { describe, expect, it } from "vitest";

import {
  MEASURED_LEDGER_CHUNK_CHARS,
  MEASURED_LEDGER_VERSION,
  buildMeasuredLedgerCohortKey,
  countMeasuredLadderCostBoundViolations,
  countMeasuredLadderMonotonicityViolations,
  decodeMeasuredLedgerRecord,
  encodeMeasuredLedgerRecord,
  joinMeasuredLedgerRecords,
  type MeasuredLedgerRecordA,
  type MeasuredLedgerRecordB,
} from "../measured-execution-ledger";

function admissionCohort(overrides: Partial<{ eligible: number; rejected: number; published: number; gateReason: string | null }> = {}) {
  return { eligible: 1, rejected: 0, published: 1, gateReason: null, ...overrides };
}

function quoteCohort(overrides: Partial<{ measured: number; failed: number; budgetDeferred: number; monotonicityViolations: number; costBoundViolations: number }> = {}) {
  return { measured: 1, failed: 0, budgetDeferred: 0, monotonicityViolations: 0, costBoundViolations: 0, ...overrides };
}

/** The reviewed 14-cohort shadow shape: 12 Curve composite policies + BSC/Base UniV3. */
function realisticRecordA(cycle = 1_755_583_200): MeasuredLedgerRecordA {
  const cohorts: MeasuredLedgerRecordA["cohorts"] = {
    "uniswap-v3-quoter-v2@bsc": admissionCohort(),
    "uniswap-v3-quoter-v2@base": admissionCohort(),
  };
  const chains = ["ethereum", "ethereum", "ethereum", "ethereum", "ethereum", "ethereum", "ethereum", "ethereum", "ethereum", "ethereum", "ethereum", "avalanche"];
  for (let index = 0; index < 12; index += 1) {
    const key = buildMeasuredLedgerCohortKey({
      chain: chains[index]!,
      poolId: `${chains[index]}:0x${index.toString(16).padStart(40, "a")}`,
      stablecoinId: `stablecoin-${index}-issuer-name`,
    });
    cohorts[key] = admissionCohort();
  }
  return {
    kind: "A",
    cycle,
    targetGenerationId: `dex-shadow-measured-targets-${cycle}`,
    solanaTargetGenerationId: `dex-solana-measured-targets-${cycle}`,
    tronTargetGenerationId: null,
    cohorts,
    truncatedCohorts: 0,
  };
}

function realisticRecordB(cycle = 1_755_590_200): MeasuredLedgerRecordB {
  const source = realisticRecordA();
  const cohorts: MeasuredLedgerRecordB["cohorts"] = {};
  for (const key of Object.keys(source.cohorts)) {
    cohorts[key] = quoteCohort();
  }
  return {
    kind: "B",
    cycle,
    targetGenerationId: source.targetGenerationId,
    quoteGenerationId: `dex-shadow-measured-quotes-${cycle}`,
    cohorts,
    truncatedCohorts: 0,
  };
}

describe("measured ledger cohort keys", () => {
  it("keys family-scoped adapters on adapter and chain only", () => {
    expect(
      buildMeasuredLedgerCohortKey({
        adapterProfileId: "uniswap-v3-quoter-v2",
        chain: "bsc",
        poolId: "bsc:0xf150d29d92e7460a1531cbc9d1abeab33d6998e4",
        stablecoinId: "usdt-tether",
      }),
    ).toBe("uniswap-v3-quoter-v2@bsc");
  });

  it("keys reviewed per-pool policies on chain, pool tail, and stablecoin", () => {
    const key = buildMeasuredLedgerCohortKey({
      adapterProfileId: "curve-stableswap-ng-metapool-underlying-v1",
      chain: "ethereum",
      poolId: "ethereum:0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
      stablecoinId: "usd1-world-liberty-financial",
    });
    expect(key).toBe("ethereum:76f08b0d:usd1-world-l");
  });

  it("distinguishes sibling policies sharing one adapter profile and chain", () => {
    const shared = {
      adapterProfileId: "curve-stableswap-ng-metapool-underlying-v1",
      chain: "ethereum",
    };
    const first = buildMeasuredLedgerCohortKey({
      ...shared,
      poolId: "ethereum:0x1111111111111111111111111111111111111111",
      stablecoinId: "usd1-world-liberty-financial",
    });
    const second = buildMeasuredLedgerCohortKey({
      ...shared,
      poolId: "ethereum:0x2222222222222222222222222222222222222222",
      stablecoinId: "nxusd-nereus",
    });
    expect(first).not.toBe(second);
  });

  it("normalizes chain casing and tolerates a missing pool identity", () => {
    expect(
      buildMeasuredLedgerCohortKey({ chain: "Base", poolId: null, stablecoinId: "usdc-circle" }),
    ).toBe(buildMeasuredLedgerCohortKey({ chain: "base", poolId: null, stablecoinId: "usdc-circle" }));
  });
});

describe("measured ledger chunk codec", () => {
  it("round-trips the realistic 14-cohort Record A shape", () => {
    const record = realisticRecordA();
    const encoded = encodeMeasuredLedgerRecord(record);
    expect(encoded.mxLedgerV).toBe(MEASURED_LEDGER_VERSION);
    expect(encoded.mxLedgerKind).toBe("A");
    expect(encoded.mxLedgerCycle).toBe(record.cycle);
    const parts = encoded.mxLedgerParts;
    expect(typeof parts).toBe("number");
    for (let index = 0; index < (parts as number); index += 1) {
      const chunk = encoded[`mxLedger${index}`];
      expect(typeof chunk).toBe("string");
      expect((chunk as string).length).toBeLessThanOrEqual(MEASURED_LEDGER_CHUNK_CHARS);
    }
    expect(decodeMeasuredLedgerRecord(encoded)).toEqual(record);
  });

  it("round-trips the realistic Record B shape within the producer-history scalar bound", () => {
    const record = realisticRecordB();
    const encoded = encodeMeasuredLedgerRecord(record);
    // normalizeHistoryMetadata persists top-level scalars via boundedJson(scalars, 2_000).
    expect(JSON.stringify(encoded).length).toBeLessThanOrEqual(2_000);
    expect(decodeMeasuredLedgerRecord(encoded)).toEqual(record);
  });

  it("round-trips an empty record for a no-shadow-targets run", () => {
    const record: MeasuredLedgerRecordA = {
      kind: "A",
      cycle: 1_755_583_200,
      targetGenerationId: null,
      solanaTargetGenerationId: null,
      tronTargetGenerationId: null,
      cohorts: {},
      truncatedCohorts: 0,
    };
    const encoded = encodeMeasuredLedgerRecord(record);
    expect(decodeMeasuredLedgerRecord(encoded)).toEqual(record);
  });

  it("truncates whole cohorts deterministically at the parts bound and records the count", () => {
    const record = realisticRecordA();
    for (let index = 0; index < 40; index += 1) {
      record.cohorts[
        buildMeasuredLedgerCohortKey({
          chain: "ethereum",
          poolId: `ethereum:0x${index.toString(16).padStart(40, "b")}`,
          stablecoinId: `overflow-coin-${index}-padding`,
        })
      ] = admissionCohort({ published: 0, rejected: 1, gateReason: "curve-stableswap:exact-pool-join-unresolved" });
    }
    const encoded = encodeMeasuredLedgerRecord(record, { maxParts: 2 });
    expect(encoded.mxLedgerParts).toBeLessThanOrEqual(2);
    const decoded = decodeMeasuredLedgerRecord(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.truncatedCohorts).toBeGreaterThan(0);
    expect(Object.keys(decoded!.cohorts).length + decoded!.truncatedCohorts).toBe(
      Object.keys(record.cohorts).length,
    );
    // Deterministic: the retained cohorts are the sorted-key prefix.
    const sortedKeys = Object.keys(record.cohorts).sort();
    expect(Object.keys(decoded!.cohorts)).toEqual(
      sortedKeys.slice(0, Object.keys(decoded!.cohorts).length),
    );
    // A second encode of the same record is byte-identical.
    expect(encodeMeasuredLedgerRecord(record, { maxParts: 2 })).toEqual(encoded);
  });

  it("keeps every chunk within the 240-char history string bound under truncation pressure", () => {
    const record = realisticRecordB();
    const encoded = encodeMeasuredLedgerRecord(record, { maxParts: 8 });
    for (const [key, value] of Object.entries(encoded)) {
      if (!key.startsWith("mxLedger") || typeof value !== "string") continue;
      expect(value.length).toBeLessThanOrEqual(240);
    }
  });

  it("fails closed on missing chunks, foreign metadata, and version drift", () => {
    const encoded = encodeMeasuredLedgerRecord(realisticRecordA());
    expect(decodeMeasuredLedgerRecord({})).toBeNull();
    expect(decodeMeasuredLedgerRecord({ rowsRead: 3, fallbackMode: "none" })).toBeNull();
    const { mxLedger0: _dropped, ...withoutFirstChunk } = encoded;
    expect(decodeMeasuredLedgerRecord(withoutFirstChunk)).toBeNull();
    expect(decodeMeasuredLedgerRecord({ ...encoded, mxLedgerV: 2 })).toBeNull();
    expect(decodeMeasuredLedgerRecord({ ...encoded, mxLedgerKind: "C" })).toBeNull();
  });
});

describe("measured ladder monotonicity", () => {
  const point = (inputUsd: number, costBps: number, passesCostBound = costBps <= 200, reverted?: true) => ({
    inputUsd,
    costBps,
    passesCostBound,
    ...(reverted ? { reverted } : {}),
  });

  it("accepts a healthy non-decreasing ladder", () => {
    expect(
      countMeasuredLadderMonotonicityViolations([
        point(1_000, 4),
        point(25_000, 9),
        point(100_000, 42),
        point(250_000, 180),
      ]),
    ).toBe(0);
  });

  it("tolerates jitter within one basis point", () => {
    expect(
      countMeasuredLadderMonotonicityViolations([point(1_000, 10), point(25_000, 9.2), point(100_000, 12)]),
    ).toBe(0);
  });

  it("counts each drop beyond one basis point over ascending notionals", () => {
    expect(
      countMeasuredLadderMonotonicityViolations([
        point(1_000, 40),
        point(25_000, 12),
        point(100_000, 60),
        point(250_000, 20),
      ]),
    ).toBe(2);
  });

  it("orders unsorted points by ascending input before checking", () => {
    expect(
      countMeasuredLadderMonotonicityViolations([point(100_000, 42), point(1_000, 4), point(25_000, 9)]),
    ).toBe(0);
  });

  it("evaluates only the points that exist", () => {
    expect(countMeasuredLadderMonotonicityViolations([])).toBe(0);
    expect(countMeasuredLadderMonotonicityViolations([point(1_000, 4)])).toBe(0);
  });
});

describe("measured ladder cost-bound consistency", () => {
  const point = (inputUsd: number, costBps: number, passesCostBound: boolean, reverted?: true) => ({
    inputUsd,
    costBps,
    passesCostBound,
    ...(reverted ? { reverted } : {}),
  });

  it("accepts a ladder whose flags match the bound, including a consistent revert", () => {
    expect(
      countMeasuredLadderCostBoundViolations(
        [point(1_000, 4, true), point(25_000, 199, true), point(100_000, 240, false), point(250_000, 10_000, false, true)],
        200,
      ),
    ).toBe(0);
  });

  it("counts a passing flag above the bound and a failing flag below it", () => {
    expect(
      countMeasuredLadderCostBoundViolations([point(1_000, 250, true), point(25_000, 40, false)], 200),
    ).toBe(2);
  });

  it("counts a revert that does not materialize as a total-loss failing point", () => {
    expect(countMeasuredLadderCostBoundViolations([point(1_000, 500, false, true)], 200)).toBe(1);
    expect(countMeasuredLadderCostBoundViolations([point(1_000, 10_000, true, true)], 200)).toBe(1);
  });
});

describe("measured ledger tri-state join", () => {
  it("derives all three tri-states across three simulated daily cycles", () => {
    const records: (MeasuredLedgerRecordA | MeasuredLedgerRecordB)[] = [];
    for (let cycleIndex = 0; cycleIndex < 3; cycleIndex += 1) {
      const aCycle = Date.UTC(2026, 7, 19 + cycleIndex, 6, 16) / 1_000;
      const bCycle = aCycle + 6_840; // the 08:10 quote run of the same UTC day
      const recordA: MeasuredLedgerRecordA = {
        kind: "A",
        cycle: aCycle,
        targetGenerationId: `dex-shadow-measured-targets-${aCycle}`,
        solanaTargetGenerationId: null,
        tronTargetGenerationId: null,
        cohorts: {
          "uniswap-v3-quoter-v2@bsc": admissionCohort(),
          "ethereum:76f08b0d:usd1-world-l": admissionCohort({ eligible: 1, rejected: 1, published: 0, gateReason: "curve-stableswap:exact-pool-join-unresolved" }),
          "ethereum:9ce4aaaa:dola-inverse": admissionCohort(),
          ...(cycleIndex === 0
            ? { "avalanche:5d74a3bb:nxusd-nereus": admissionCohort() }
            : {}),
        },
        truncatedCohorts: 0,
      };
      const recordB: MeasuredLedgerRecordB = {
        kind: "B",
        cycle: bCycle,
        targetGenerationId: recordA.targetGenerationId,
        quoteGenerationId: `dex-shadow-measured-quotes-${bCycle}`,
        cohorts: {
          "uniswap-v3-quoter-v2@bsc": quoteCohort(),
          "ethereum:9ce4aaaa:dola-inverse": quoteCohort({ measured: 0, failed: 1 }),
          ...(cycleIndex === 0
            ? { "avalanche:5d74a3bb:nxusd-nereus": quoteCohort() }
            : {}),
        },
        truncatedCohorts: 0,
      };
      records.push(recordA, recordB);
    }

    const joined = joinMeasuredLedgerRecords(records);
    const byDayAndCohort = new Map(
      joined.map((row) => [`${row.cycleDay}|${row.cohortKey}`, row.state] as const),
    );
    expect(byDayAndCohort.size).toBe(3 * 4);

    for (const [index, cycleDay] of ["2026-08-19", "2026-08-20", "2026-08-21"].entries()) {
      expect(byDayAndCohort.get(`${cycleDay}|uniswap-v3-quoter-v2@bsc`)).toBe("quoted");
      expect(byDayAndCohort.get(`${cycleDay}|ethereum:76f08b0d:usd1-world-l`)).toBe("eligible-source-rejected");
      expect(byDayAndCohort.get(`${cycleDay}|ethereum:9ce4aaaa:dola-inverse`)).toBe("target-produced-no-quote");
      expect(byDayAndCohort.get(`${cycleDay}|avalanche:5d74a3bb:nxusd-nereus`)).toBe(
        index === 0 ? "quoted" : "no-eligible-source-row",
      );
    }
  });

  it("joins B to A by target generation id ahead of the calendar day", () => {
    const recordA: MeasuredLedgerRecordA = {
      kind: "A",
      cycle: 1_755_583_200,
      targetGenerationId: "dex-shadow-measured-targets-late",
      solanaTargetGenerationId: null,
      tronTargetGenerationId: null,
      cohorts: { "uniswap-v3-quoter-v2@bsc": admissionCohort() },
      truncatedCohorts: 0,
    };
    // Quote run delayed past the UTC midnight boundary still joins its generation.
    const recordB: MeasuredLedgerRecordB = {
      kind: "B",
      cycle: 1_755_583_200 + 86_400,
      targetGenerationId: "dex-shadow-measured-targets-late",
      quoteGenerationId: "dex-shadow-measured-quotes-late",
      cohorts: { "uniswap-v3-quoter-v2@bsc": quoteCohort() },
      truncatedCohorts: 0,
    };
    const joined = joinMeasuredLedgerRecords([recordA, recordB]);
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      cohortKey: "uniswap-v3-quoter-v2@bsc",
      state: "quoted",
    });
  });

  it("marks a published cohort with no B record at all as target-produced-no-quote", () => {
    const recordA: MeasuredLedgerRecordA = {
      kind: "A",
      cycle: 1_755_583_200,
      targetGenerationId: "dex-shadow-measured-targets-solo",
      solanaTargetGenerationId: null,
      tronTargetGenerationId: null,
      cohorts: { "uniswap-v3-quoter-v2@bsc": admissionCohort() },
      truncatedCohorts: 0,
    };
    const joined = joinMeasuredLedgerRecords([recordA]);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.state).toBe("target-produced-no-quote");
    expect(joined[0]!.quotes).toBeNull();
  });
});
