import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import {
  encodeMeasuredLedgerRecord,
  type MeasuredLedgerRecordA,
  type MeasuredLedgerRecordB,
} from "@shared/lib/measured-execution-ledger";
import { recordProducerOutcome } from "../producer-history";
import {
  loadMeasuredExecutionLedgerRecords,
  loadMeasuredExecutionLedgerTriState,
} from "../measured-execution-ledger-query";
import type { CronResult } from "../cron-logger";

const DAY_SEC = 86_400;

function admissionRecord(cycle: number, dayIndex: number): MeasuredLedgerRecordA {
  return {
    kind: "A",
    cycle,
    targetGenerationId: `dex-shadow-measured-targets-${cycle}`,
    solanaTargetGenerationId: null,
    tronTargetGenerationId: null,
    cohorts: {
      "uniswap-v3-quoter-v2@bsc": { eligible: 1, rejected: 0, published: 1, gateReason: null },
      "ethereum:76f08b0d:usd1-world-l": {
        eligible: 1,
        rejected: 1,
        published: 0,
        gateReason: "curve-stableswap:exact-pool-join-unresolved",
      },
      // Publishes daily but the quote lane never measures it.
      "ethereum:9ce4aaaa:dola-inverse": { eligible: 1, rejected: 0, published: 1, gateReason: null },
      // Present on day 0 only; later days derive no-eligible-source-row.
      ...(dayIndex === 0
        ? { "avalanche:5d74a3bb:nxusd-nereus": { eligible: 1, rejected: 0, published: 1, gateReason: null } }
        : {}),
    },
    truncatedCohorts: 0,
  };
}

function quoteRecord(cycle: number, targetGenerationId: string, dayIndex: number): MeasuredLedgerRecordB {
  return {
    kind: "B",
    cycle,
    targetGenerationId,
    quoteGenerationId: `dex-shadow-measured-quotes-${cycle}`,
    cohorts: {
      "uniswap-v3-quoter-v2@bsc": {
        measured: 1,
        failed: 0,
        budgetDeferred: 0,
        monotonicityViolations: 0,
        costBoundViolations: 0,
      },
      "ethereum:9ce4aaaa:dola-inverse": {
        measured: 0,
        failed: 1,
        budgetDeferred: 0,
        monotonicityViolations: 1,
        costBoundViolations: 0,
      },
      ...(dayIndex === 0
        ? {
            "avalanche:5d74a3bb:nxusd-nereus": {
              measured: 1,
              failed: 0,
              budgetDeferred: 0,
              monotonicityViolations: 0,
              costBoundViolations: 0,
            },
          }
        : {}),
    },
    truncatedCohorts: 0,
  };
}

describe("measured execution ledger retrieval", () => {
  it("reads, joins, and tri-states three daily cycles written through the real producer-history path", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const firstCycle = Math.floor(Date.UTC(2026, 7, 16, 6, 16) / 1_000);

    for (let dayIndex = 0; dayIndex < 3; dayIndex += 1) {
      const admissionCycle = firstCycle + dayIndex * DAY_SEC;
      const quoteCycle = admissionCycle + 6_840;
      const recordA = admissionRecord(admissionCycle, dayIndex);

      // Record A rides the 06:16 scoring producer row beside its usual scalars.
      await recordProducerOutcome(db, {
        scheduleKey: "halfHourlyChartsOffset",
        job: "sync-dex-liquidity",
        producerPath: "halfHourlyChartsOffset",
        producerKind: "scheduled-job",
        invocationId: `scoring-${dayIndex}`,
        idempotencyKey: `scoring-${dayIndex}`,
        invokedAt: admissionCycle,
        completedAt: admissionCycle + 120,
        outcome: "ok",
        itemCount: 300,
        metadata: JSON.stringify({
          rowsRead: 4_000,
          rowsWritten: 300,
          validationFailures: 0,
          poolRejections: [{ reason: "non-scalar-diagnostics-are-dropped" }],
          ...encodeMeasuredLedgerRecord(recordA, { maxParts: 5 }),
        }),
        productivity: { productive: true },
      });

      // Record B flows through the daily-0810 handler's settled EVM shadow
      // lane (the native lanes were removed in Liquidity Score v6 Phase 3)
      // and is written as a zero-output, nonproductive run: metadata must
      // survive at the top level.
      const evmShadowLane: CronResult = {
        status: "ok",
        itemCount: 0,
        metadata: JSON.stringify({
          lane: "shadow",
          measuredCount: 0,
          ...encodeMeasuredLedgerRecord(
            quoteRecord(quoteCycle, recordA.targetGenerationId!, dayIndex),
          ),
        }),
        productivity: { productive: false, reason: "no-measured-execution" },
      };
      const merged = evmShadowLane;
      expect(merged.productivity?.productive).toBe(false);
      await recordProducerOutcome(db, {
        scheduleKey: "daily0810Utc",
        job: "sync-cl-exit-depth",
        producerPath: "daily0810Utc",
        producerKind: "scheduled-job",
        invocationId: `shadow-quotes-${dayIndex}`,
        idempotencyKey: `shadow-quotes-${dayIndex}`,
        invokedAt: quoteCycle,
        completedAt: quoteCycle + 300,
        outcome: merged.status ?? "ok",
        itemCount: merged.itemCount,
        metadata: merged.metadata ?? null,
        productivity: merged.productivity,
      });
    }

    const fromSec = firstCycle - DAY_SEC;
    const toSec = firstCycle + 4 * DAY_SEC;
    const records = await loadMeasuredExecutionLedgerRecords(db, { fromSec, toSec });
    expect(records.filter((record) => record.kind === "A")).toHaveLength(3);
    expect(records.filter((record) => record.kind === "B")).toHaveLength(3);

    const joined = await loadMeasuredExecutionLedgerTriState(db, { fromSec, toSec });
    const byDayAndCohort = new Map(
      joined.map((row) => [`${row.cycleDay}|${row.cohortKey}`, row] as const),
    );
    for (const [dayIndex, cycleDay] of ["2026-08-16", "2026-08-17", "2026-08-18"].entries()) {
      expect(byDayAndCohort.get(`${cycleDay}|uniswap-v3-quoter-v2@bsc`)?.state).toBe("quoted");
      expect(byDayAndCohort.get(`${cycleDay}|ethereum:76f08b0d:usd1-world-l`)).toMatchObject({
        state: "eligible-source-rejected",
        admission: { gateReason: "curve-stableswap:exact-pool-join-unresolved" },
      });
      expect(byDayAndCohort.get(`${cycleDay}|ethereum:9ce4aaaa:dola-inverse`)).toMatchObject({
        state: "target-produced-no-quote",
        quotes: { monotonicityViolations: 1 },
      });
      expect(byDayAndCohort.get(`${cycleDay}|avalanche:5d74a3bb:nxusd-nereus`)?.state).toBe(
        dayIndex === 0 ? "quoted" : "no-eligible-source-row",
      );
    }
    sqlite.close();
  });

  it("collapses a retried cycle to the latest row and skips undecodable metadata", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    const cycle = Math.floor(Date.UTC(2026, 7, 16, 8, 10) / 1_000);
    const identity = {
      scheduleKey: "daily0810Utc",
      job: "sync-cl-exit-depth",
      producerPath: "daily0810Utc",
      producerKind: "scheduled-job",
    };
    const record = quoteRecord(cycle, "dex-shadow-measured-targets-x", 1);
    await recordProducerOutcome(db, {
      ...identity,
      invocationId: "first",
      idempotencyKey: "first",
      invokedAt: cycle,
      completedAt: cycle + 60,
      metadata: JSON.stringify({ ...encodeMeasuredLedgerRecord({ ...record, cohorts: {} }) }),
      outcome: "error",
      productivity: { productive: false, reason: "shadow-failed" },
    });
    await recordProducerOutcome(db, {
      ...identity,
      invocationId: "second",
      idempotencyKey: "second",
      invokedAt: cycle,
      completedAt: cycle + 120,
      metadata: JSON.stringify({ ...encodeMeasuredLedgerRecord(record) }),
      outcome: "ok",
      productivity: { productive: false, reason: "no-measured-execution" },
    });
    // A row whose chunks were corrupted decodes to nothing instead of failing.
    await recordProducerOutcome(db, {
      ...identity,
      invocationId: "corrupt",
      idempotencyKey: "corrupt",
      invokedAt: cycle + 200,
      completedAt: cycle + 260,
      metadata: JSON.stringify({ mxLedgerV: 1, mxLedgerKind: "B", mxLedgerCycle: cycle + 1, mxLedgerParts: 3, mxLedger0: "{" }),
      outcome: "ok",
      productivity: { productive: false, reason: "no-measured-execution" },
    });

    const records = await loadMeasuredExecutionLedgerRecords(db, {
      fromSec: cycle - 60,
      toSec: cycle + 600,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: "B", cycle });
    expect(Object.keys(records[0]!.cohorts)).toHaveLength(2);
    sqlite.close();
  });
});
