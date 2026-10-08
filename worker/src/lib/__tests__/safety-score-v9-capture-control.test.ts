import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import type { SafetyScoreV9CaptureTuple } from "@shared/types/safety-score-v9-capture-control";
import {
  buildSafetyScoreV9CaptureControl, commitCaptureControl, hasPendingAttribution,
  parseSafetyScoreV9CaptureControl, prepareAttributionSettlement, requestRecapture,
  SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY,
} from "../safety-score-v9/capture-control";
import { prepareCacheUpsert } from "../db-cache";
import { batchExecute } from "../d1-primitives";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.useRealTimers(); });
function capture(clockSec = Date.parse("2026-10-07T20:17:00Z") / 1_000): SafetyScoreV9CaptureTuple {
  const baseInputGenerationId = `report-cards-input:v1:${"a".repeat(64)}`;
  const sourceGeneration = "report-cards:10.05:fixture";
  return {
    safetyScoreIdentity: buildSafetyScoreV9InputIdentity({ methodologyVersion: "10.05", baseInputGenerationId, publicationGenerationId: sourceGeneration }),
    baseInputGenerationId, sourceGeneration, clockSec, registryFingerprint: "b".repeat(64),
    workerVersion: "worker-old", workerUploadedAtSec: clockSec - 60,
  };
}
const target = { workerVersion: "worker-new", workerUploadedAtSec: Date.parse("2026-10-07T20:18:00Z") / 1_000,
  evaluationBuildDigest: "c".repeat(64), registryFingerprint: "d".repeat(64) };

async function loadControl(db: D1Database) {
  const row = await db.prepare("SELECT value FROM cache WHERE key = ?").bind(SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY).first<{ value: string }>();
  return parseSafetyScoreV9CaptureControl(row!.value);
}

describe("V9 prepare-owned capture control", () => {
  it.each([
    ["2026-10-07T20:17:00Z", "2026-10-07T20:23:00Z", "2026-10-07T20:26:00Z"],
    ["2026-10-07T20:47:00Z", "2026-10-07T20:53:00Z", "2026-10-07T20:56:00Z"],
    ["2026-10-07T20:59:00Z", "2026-10-07T21:08:00Z", "2026-10-07T21:11:00Z"],
    ["2026-10-07T20:23:00Z", "2026-10-07T20:38:00Z", "2026-10-07T20:41:00Z"],
  ])("derives the first eligible slot after commit %s", (commit, due, expiry) => {
    const sec = Date.parse(commit) / 1_000;
    const control = buildSafetyScoreV9CaptureControl(capture(sec), sec);
    expect(control.attribution.dueSlotStartedAtSec).toBe(Date.parse(due) / 1_000);
    expect(control.attribution.pendingUntilSec).toBe(Date.parse(expiry) / 1_000);
  });

  it("expires at deadline equality and never extends the source budget", () => {
    const tuple = capture();
    const control = buildSafetyScoreV9CaptureControl(tuple, tuple.clockSec + 1_700);
    const source = { ...tuple, activeAssetIds: [], aggregateCirculatingById: {}, chainCirculatingById: {} };
    expect(control.attribution.pendingUntilSec).toBe(tuple.clockSec + 1_800);
    expect(hasPendingAttribution(control, source, tuple.clockSec + 1_799)).toBe(true);
    expect(hasPendingAttribution(control, source, tuple.clockSec + 1_800)).toBe(false);
    expect(hasPendingAttribution(control, { ...source, clockSec: source.clockSec + 1 }, tuple.clockSec + 1_799)).toBe(false);
  });

  it("rolls every capture row back if the sidecar transaction fails", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`CREATE TRIGGER reject_capture_control BEFORE INSERT ON cache
      WHEN NEW.key = '${SAFETY_SCORE_V9_CAPTURE_CONTROL_CACHE_KEY}' BEGIN SELECT RAISE(ABORT, 'sidecar failed'); END`);
    const tuple = capture();
    await expect(commitCaptureControl(db, [{ key: "input", value: "base" }, { key: "seed", value: "seed" }],
      buildSafetyScoreV9CaptureControl(tuple, tuple.clockSec), true, tuple.clockSec)).rejects.toThrow();
    expect(sqlite.prepare("SELECT count(*) count FROM cache WHERE key IN ('input','seed')").get()).toEqual({ count: 0 });
  });

  it("preserves concurrent newer requests until a matching complete seed commit", async () => {
    const { db } = fixtures.open();
    const tuple = capture();
    const control = buildSafetyScoreV9CaptureControl(tuple, tuple.clockSec);
    await commitCaptureControl(db, [], control, true, tuple.clockSec);
    await requestRecapture(db, tuple, target);
    await commitCaptureControl(db, [], control, true, tuple.clockSec + 1);
    expect((await loadControl(db)).recaptureRequest?.targetWorkerVersion).toBe(target.workerVersion);
    const matching = buildSafetyScoreV9CaptureControl({ ...tuple,
      workerVersion: target.workerVersion, workerUploadedAtSec: target.workerUploadedAtSec,
      registryFingerprint: target.registryFingerprint,
      safetyScoreIdentity: { ...tuple.safetyScoreIdentity, evaluationBuildDigest: target.evaluationBuildDigest },
    }, tuple.clockSec + 2);
    await commitCaptureControl(db, [], matching, false, tuple.clockSec + 2);
    expect((await loadControl(db)).recaptureRequest).not.toBeNull();
    await commitCaptureControl(db, [{ key: "input", value: "complete" }, { key: "seed", value: "complete" }], matching, true, tuple.clockSec + 3);
    expect((await loadControl(db)).recaptureRequest).toBeNull();
  });

  it("fails closed on an unpersisted request but names a proven advanced capture", async () => {
    const { db, sqlite } = fixtures.open();
    const tuple = capture();
    await expect(requestRecapture(db, tuple, target)).rejects.toThrow("not persisted");
    const next = { ...tuple, clockSec: tuple.clockSec + 1 };
    await commitCaptureControl(db, [], buildSafetyScoreV9CaptureControl(next, next.clockSec), true, next.clockSec);
    expect(await requestRecapture(db, tuple, target)).toBe("advanced");
    sqlite.exec(`CREATE TRIGGER reject_request BEFORE UPDATE ON cache BEGIN SELECT RAISE(ABORT, 'request failed'); END`);
    await expect(requestRecapture(db, next, target)).rejects.toThrow("request failed");
  });

  it("an older requester cannot replace a newer deployment request", async () => {
    const { db } = fixtures.open();
    const tuple = capture();
    await commitCaptureControl(db, [], buildSafetyScoreV9CaptureControl(tuple, tuple.clockSec), true, tuple.clockSec);
    await requestRecapture(db, tuple, target);
    await expect(requestRecapture(db, tuple, { ...target, workerVersion: "intermediate", workerUploadedAtSec: target.workerUploadedAtSec - 1 }))
      .rejects.toThrow("not persisted");
    expect((await loadControl(db)).recaptureRequest?.targetWorkerVersion).toBe(target.workerVersion);
  });

  it("settles only the exact source and admitted slot, atomically with a monotonic generation", async () => {
    const { db } = fixtures.open();
    const tuple = capture();
    const control = buildSafetyScoreV9CaptureControl(tuple, tuple.clockSec);
    await commitCaptureControl(db, [], control, true, tuple.clockSec);
    expect(prepareAttributionSettlement(db, control, { ...tuple, sourceGeneration: "other" }, control.attribution.dueSlotStartedAtSec, "ok", "generation")).toBeNull();
    expect(prepareAttributionSettlement(db, control, tuple, control.attribution.dueSlotStartedAtSec - 900, "ok", "generation")).toBeNull();
    const publication = { key: "generation", value: "newer", updatedAt: tuple.clockSec + 1 };
    await prepareCacheUpsert(db, publication).run();
    const oldPublication = { ...publication, value: "older", updatedAt: tuple.clockSec };
    await batchExecute(db, [prepareCacheUpsert(db, oldPublication, "if-newer"),
      prepareAttributionSettlement(db, control, tuple, control.attribution.dueSlotStartedAtSec, "ok", "older", oldPublication)!]);
    expect((await loadControl(db)).attribution.status).toBe("pending");
    await batchExecute(db, [prepareCacheUpsert(db, publication, "if-newer"),
      prepareAttributionSettlement(db, control, tuple, control.attribution.dueSlotStartedAtSec, "degraded", "newer", publication)!]);
    expect((await loadControl(db)).attribution).toMatchObject({ status: "settled", outcome: "degraded", generationId: "newer", pendingUntilSec: control.attribution.pendingUntilSec });
  });

  it("settlement misses cannot revoke a newer source request", async () => {
    const { db } = fixtures.open();
    const tuple = capture();
    const old = buildSafetyScoreV9CaptureControl(tuple, tuple.clockSec);
    await commitCaptureControl(db, [], old, true, tuple.clockSec);
    const next = buildSafetyScoreV9CaptureControl({ ...tuple, clockSec: tuple.clockSec + 1 }, tuple.clockSec + 1);
    await commitCaptureControl(db, [], next, true, tuple.clockSec + 1);
    const result = await prepareAttributionSettlement(db, old, tuple, old.attribution.dueSlotStartedAtSec, "error", null)!.run();
    expect(result.meta.changes).toBe(0);
    expect((await loadControl(db)).attribution.status).toBe("pending");
  });
});
