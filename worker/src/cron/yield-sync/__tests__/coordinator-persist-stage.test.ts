import { beforeEach, describe, expect, it, vi } from "vitest";
import { runYieldCoordinatorPersistStage, type YieldCoordinatorPersistStageParams } from "../coordinator-persist-stage";
import { publishYieldCoordinatorResults } from "../coordinator-persist";

vi.mock("../coordinator-persist", () => ({ publishYieldCoordinatorResults: vi.fn() }));

function params(): YieldCoordinatorPersistStageParams {
  return {
    db: {},
    fetched: {
      startSec: 1_800_000_000,
      yieldCoins: [],
      reportYieldProgress: vi.fn().mockResolvedValue(undefined),
      onChainRates: new Map(),
      dlPoolsMeta: { poolCount: 0 },
      supplementalMeta: { mode: "cache", sourceCount: 12, degradedFamilies: [] },
    },
    normalized: {
      evaluatedSources: [], resolvedIds: [], rowsRejected: 0,
      defaultSafetyIds: new Set(), resolvedYieldBearingIds: new Set(),
      envelopeRejections: [], optionalSourceFailures: [], historySnapshots: {},
    },
    health: {
      acceptedSources: [], safetySnapshotMeta: {}, previewRankingsPayload: { rankings: [] },
      degradationReasons: [], nextOnChainHealthState: {},
    },
  } as unknown as YieldCoordinatorPersistStageParams;
}

beforeEach(() => vi.clearAllMocks());

describe("yield publication terminal outcome", () => {
  it.each([
    [],
    ["yield-supplemental:family-degraded:aaveV3:upstream-unavailable"],
    ["yield-publication:quarantined-source:bad-asset:currentApy"],
    ["yield-publication:coverage-regression:opportunity"],
  ])("finishes applied publication with quality reasons %j", async (...reasons: string[]) => {
    vi.mocked(publishYieldCoordinatorResults).mockResolvedValue({
      ok: true, updatedCount: 1, degradationReasons: reasons, validationFailures: 0,
      cacheWriteSkipped: false, casSkipped: false, skipReason: null, publicationStats: null,
    });
    const result = await runYieldCoordinatorPersistStage(params());
    expect(result.status).toBe("ok");
    expect(result.itemCount).toBe(1);
    expect(JSON.parse(result.metadata!)).toMatchObject({
      quality: { degraded: reasons.length > 0, reasons },
    });
    expect(JSON.parse(result.metadata!).reason).toBeUndefined();
  });

  it("completes a Pendle-only outage without degrading publication quality", async () => {
    vi.mocked(publishYieldCoordinatorResults).mockResolvedValue({
      ok: true, updatedCount: 1, degradationReasons: [], validationFailures: 0,
      cacheWriteSkipped: false, casSkipped: false, skipReason: null, publicationStats: null,
    });
    const input = params();
    input.fetched.supplementalMeta.degradedFamilies = ["pendle"];
    input.fetched.supplementalMeta.degradedFamilyReasons = { pendle: "pendle-rate-limited-backoff" };
    const result = await runYieldCoordinatorPersistStage(input);
    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata!).quality).toEqual({
      degraded: false,
      reasons: [],
      advisoryReasons: ["yield-supplemental:family-degraded:pendle:pendle-rate-limited-backoff"],
    });
  });

  it("does not mark a CAS-skipped publication as completed", async () => {
    vi.mocked(publishYieldCoordinatorResults).mockResolvedValue({
      ok: true, updatedCount: 0, degradationReasons: [], validationFailures: 0,
      cacheWriteSkipped: true, casSkipped: true, skipReason: "newer-publication", publicationStats: null,
    });
    const result = await runYieldCoordinatorPersistStage(params());
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!).reason).toBe("newer-publication");
  });

  it("keeps the blocked publication reason", async () => {
    vi.mocked(publishYieldCoordinatorResults).mockResolvedValue({
      ok: false,
      result: { status: "degraded", itemCount: 0, metadata: JSON.stringify({ reason: "yield-publication-transaction-failed" }) },
    });
    const result = await runYieldCoordinatorPersistStage(params());
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata!).reason).toBe("yield-publication-transaction-failed");
  });
});
