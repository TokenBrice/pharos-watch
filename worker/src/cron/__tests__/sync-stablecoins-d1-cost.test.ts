import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import type { CronResult } from "../../lib/cron-logger";
import { observeMockD1Cost } from "../../lib/__tests__/d1-cost.test-support";

const stages = vi.hoisted(() => ({ intake: vi.fn(), pricing: vi.fn(), publish: vi.fn() }));
vi.mock("../sync-stablecoins/stages", () => ({
  runStablecoinsIntakeStage: stages.intake,
  runStablecoinsPricingStage: stages.pricing,
}));
vi.mock("../sync-stablecoins/publication", () => ({
  buildMainStablecoinsPublicationPolicy: vi.fn(),
  loadStablecoinsPublicationContinuity: vi.fn(async () => ({})),
  runStablecoinsPostIntakePublication: stages.publish,
}));

import { syncStablecoins } from "../sync-stablecoins";

beforeEach(() => {
  vi.clearAllMocks();
  stages.intake.mockReset().mockResolvedValue({ kind: "main" });
  stages.pricing.mockReset().mockResolvedValue({ enrichStats: {} });
  stages.publish.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("syncStablecoins D1 cost metadata", () => {
  it("snapshots after publication SQL settles without changing its rows or result", async () => {
    const rows = [{ id: "stablecoin-evidence" }];
    const db = mockD1([{ match: "SELECT stablecoin_evidence", rows }, { match: "UPDATE stablecoins_cache", rows: [] }]);
    const assertCost = observeMockD1Cost(db);
    const published: CronResult = { status: "ok", itemCount: 1, metadata: JSON.stringify({ path: "main", outputPublishedAt: 123 }) };
    stages.publish.mockImplementationOnce(async ({ db: trackedDb }: { db: D1Database }) => {
      expect((await trackedDb.prepare("SELECT stablecoin_evidence").all()).results).toBe(rows);
      await trackedDb.batch([trackedDb.prepare("UPDATE stablecoins_cache"), trackedDb.prepare("UPDATE stablecoins_cache")]);
      return published;
    });
    const result = await syncStablecoins(db);
    expect(result).toMatchObject({ status: published.status, itemCount: published.itemCount });
    expect(JSON.parse(result.metadata!)).toMatchObject(JSON.parse(published.metadata!));
    expect(assertCost(result)).toMatchObject({ queries: 3, bindingCalls: 2, batchCalls: 1 });
    expect(published.metadata).toBe(JSON.stringify({ path: "main", outputPublishedAt: 123 }));
  });

  it.each(["intake", "fallback", "pricing"])("preserves %s early-return results and includes their SQL costs", async (path) => {
    const db = mockD1([{ match: "SELECT early_result", rows: [{ id: path }] }]);
    const assertCost = observeMockD1Cost(db);
    const returned = { status: "degraded", itemCount: 2, metadata: JSON.stringify({ path }), error: "original diagnostic" };
    const execute = async ({ db: trackedDb }: { db: D1Database }) => {
      expect((await trackedDb.prepare("SELECT early_result").first<{ id: string }>())?.id).toBe(path);
      return path === "fallback" ? { kind: "fallback", result: returned } : returned;
    };
    if (path === "pricing") stages.pricing.mockImplementationOnce(execute);
    else stages.intake.mockImplementationOnce(execute);
    const result = await syncStablecoins(db);
    expect(result).toMatchObject({ status: returned.status, itemCount: returned.itemCount, error: returned.error });
    expect(JSON.parse(result.metadata!)).toMatchObject({ path });
    expect(assertCost(result)).toMatchObject({ queries: 1, bindingCalls: 1, batchCalls: 0, sqlDurationMs: null, servedByRegion: null });
    expect(stages.publish).not.toHaveBeenCalled();
  });

  it("keeps pre-aborted work at zero observed calls", async () => {
    const db = mockD1();
    const assertCost = observeMockD1Cost(db);
    const controller = new AbortController();
    controller.abort("already cancelled");
    const result = await syncStablecoins(db, controller.signal);
    expect(result).toMatchObject({ aborted: true });
    expect(assertCost(result)).toMatchObject({ queries: 0, bindingCalls: 0, batchCalls: 0 });
    expect(stages.intake).not.toHaveBeenCalled();
  });

  it.each(["intake", "publication"])("preserves the original %s SQL exception", async (stage) => {
    const failure = new Error("original SQL failure");
    const db = mockD1([{ match: "SELECT failed_evidence", rows: [], throwError: failure }]);
    const execute = async ({ db: trackedDb }: { db: D1Database }) => trackedDb.prepare("SELECT failed_evidence").all();
    (stage === "intake" ? stages.intake : stages.publish).mockImplementationOnce(execute);
    await expect(syncStablecoins(db)).rejects.toBe(failure);
  });
});
