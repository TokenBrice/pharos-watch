import type {
  SolanaMeasuredExecutionProfile,
  SolanaMeasuredExecutionTarget,
} from "@shared/types/solana-measured-execution";
import type {
  TronMeasuredExecutionProfile,
  TronMeasuredExecutionTarget,
} from "@shared/types/tron-measured-execution";
import { describe, expect, it } from "vitest";
import { syncNativeMeasuredExecution } from "../native-sync";
import { SOLANA_NATIVE_SYNC_ADAPTER } from "../solana-sync";
import { TRON_NATIVE_SYNC_ADAPTER } from "../tron-sync";

const CURSOR_STATE = {
  cursor: null,
  cycleStartedAt: 900,
  updatedAt: null,
  completedAt: null,
  pagesFetched: 0,
};

function solanaTargets(count: number): SolanaMeasuredExecutionTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    targetId: `solana-${index.toString().padStart(2, "0")}`,
    adapterProfileId: "orca-whirlpool-jupiter-v1",
    retainedTvlUsd: count - index,
  })) as SolanaMeasuredExecutionTarget[];
}

function tronTargets(count: number): TronMeasuredExecutionTarget[] {
  return Array.from({ length: count }, (_, index) => ({
    targetId: `tron-${index.toString().padStart(2, "0")}`,
    adapterProfileId: "sunswap-v2-router-v1",
    retainedTvlUsd: count - index,
  })) as TronMeasuredExecutionTarget[];
}

describe("native measured-execution publication sync", () => {
  it("preserves Solana rotation, cursor movement, failure aggregation, and publication output", async () => {
    const targets = solanaTargets(13);
    const published: unknown[] = [];
    const cursorWrites: Array<{ cursor: string; pagesFetched: number }> = [];
    const profile = { chain: "solana" } as unknown as SolanaMeasuredExecutionProfile;
    const adapter = {
      ...SOLANA_NATIVE_SYNC_ADAPTER,
      loadTargetGeneration: async () => ({
        generationId: "solana-targets-1",
        targets,
        publishedAt: 1_000,
      }),
      readCursor: async () => CURSOR_STATE,
      buildQuoteGenerationId: () => "solana-quotes-1",
      measureTarget: async () => profile,
      publish: async (input: Parameters<typeof SOLANA_NATIVE_SYNC_ADAPTER.publish>[0]) => {
        published.push(...input.outcomes);
        return { generationId: input.generationId, measuredCount: 12, failedCount: 1 };
      },
      writeCursor: async (input: Parameters<typeof SOLANA_NATIVE_SYNC_ADAPTER.writeCursor>[0]) => {
        cursorWrites.push({ cursor: input.cursor, pagesFetched: input.pagesFetched });
        return { written: true as const, errorClass: null };
      },
    };

    const result = await syncNativeMeasuredExecution({
      db: {} as D1Database,
      adapter,
    });
    const metadata = JSON.parse(result.metadata ?? "{}");

    expect(cursorWrites).toEqual([{ cursor: "solana-11", pagesFetched: 12 }]);
    expect(published).toHaveLength(13);
    expect(published[published.length - 1]).toMatchObject({
      target: { targetId: "solana-12" },
      status: "failed",
      failureReason: "budget-deferred",
      rawPayload: {
        adapterProfileId: "orca-whirlpool-jupiter-v1",
        targetId: "solana-12",
        failureReason: "budget-deferred",
      },
    });
    expect(metadata).toMatchObject({
      quoteGenerationId: "solana-quotes-1",
      measuredCount: 12,
      failedCount: 1,
      deferredCount: 1,
      nextAdmissionCursor: "solana-11",
      cursorWriteStatus: "written",
      failuresByReason: { "budget-deferred": 1 },
    });
  });

  it("preserves Tron full-cohort rotation, cursor movement, and publication output", async () => {
    const targets = tronTargets(22);
    const published: unknown[] = [];
    const cursorWrites: Array<{ cursor: string; pagesFetched: number }> = [];
    const profile = { chain: "tron" } as unknown as TronMeasuredExecutionProfile;
    const adapter = {
      ...TRON_NATIVE_SYNC_ADAPTER,
      loadTargetGeneration: async () => ({
        generationId: "tron-targets-1",
        targets,
        publishedAt: 1_000,
      }),
      readCursor: async () => CURSOR_STATE,
      buildQuoteGenerationId: () => "tron-quotes-1",
      measureTarget: async () => profile,
      publish: async (input: Parameters<typeof TRON_NATIVE_SYNC_ADAPTER.publish>[0]) => {
        published.push(...input.outcomes);
        return { generationId: input.generationId, measuredCount: 21, failedCount: 1 };
      },
      writeCursor: async (input: Parameters<typeof TRON_NATIVE_SYNC_ADAPTER.writeCursor>[0]) => {
        cursorWrites.push({ cursor: input.cursor, pagesFetched: input.pagesFetched });
        return { written: true as const, errorClass: null };
      },
    };

    const result = await syncNativeMeasuredExecution({
      db: {} as D1Database,
      adapter,
    });
    const metadata = JSON.parse(result.metadata ?? "{}");

    expect(cursorWrites).toEqual([{ cursor: "tron-20", pagesFetched: 21 }]);
    expect(published).toHaveLength(22);
    expect(published[published.length - 1]).toMatchObject({
      target: { targetId: "tron-21" },
      status: "failed",
      failureReason: "budget-deferred",
      rawPayload: {
        adapterProfileId: "sunswap-v2-router-v1",
        targetId: "tron-21",
        failureReason: "budget-deferred",
      },
    });
    expect(result.status).toBe("ok");
    expect(metadata).toMatchObject({
      quoteGenerationId: "tron-quotes-1",
      measuredCount: 21,
      failedCount: 1,
      deferredCount: 1,
      nextAdmissionCursor: "tron-20",
      cursorWriteStatus: "written",
      failuresByReason: { "budget-deferred": 1 },
      rateLimitDeferredCount: 0,
      rateLimitStopped: false,
    });
  });
});
