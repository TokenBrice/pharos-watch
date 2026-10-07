import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { beginLiveReserveCheckpoint } from "../scheduled-recovery-checkpoint";
import { acceptedReserveMetadataMap, assessConsumedRedemptionReserves, consumedReserveInput, loadAcceptedReserveGeneration, sealAcceptedReserveGeneration } from "../accepted-reserve-generation";
import { assessReserveSnapshotFreshness, evaluateLiveReserveAdmission } from "../live-reserves/store-snapshot-state";

const CLOCK = 1_790_000_000;
const ASSET = "iusd-infinifi";
const coin = ACTIVE_META_BY_ID.get(ASSET)!;
const fingerprint = computeLiveReserveConfigFingerprint(coin.liveReservesConfig!);
const openDatabases: Array<{ close(): void }> = [];
afterEach(() => { for (const sqlite of openDatabases.splice(0)) sqlite.close(); });

async function harness(slot = CLOCK, fetchedAt = CLOCK - 60) {
  const sqlite = createLatestSchemaSqlite().sqlite;
  openDatabases.push(sqlite);
  const db = createSqliteD1(sqlite);
  const identity = await beginLiveReserveCheckpoint(db, { slotStartedAt: slot, invocationId: `owner:${slot}`, nowSec: CLOCK });
  sqlite.prepare(`UPDATE worker_scheduled_checkpoints SET queue_hash = 'test', items_done = 2, items_total = 2, next_item_key = NULL, child_dispositions_json = '{"sync-live-reserves":"running"}' WHERE slot_started_at = ?`).run(slot);
  sqlite.prepare(`INSERT INTO reserve_composition (stablecoin_id, slices, fetched_at, source, attempt_id, metadata, warning_count, warnings, adapter_source_model, adapter_evidence_class, config_fingerprint) VALUES (?, ?, ?, ?, 'success', ?, 0, '[]', 'dynamic-mix', 'independent', ?)`).run(ASSET, '[{"name":"Cash","pct":100,"risk":"low"}]', fetchedAt, coin.liveReservesConfig!.adapter, '{"freshnessMode":"not-applicable","redemption":{"capacityUsd":1000000}}', fingerprint);
  sqlite.prepare(`INSERT INTO reserve_sync_state (stablecoin_id, adapter_key, breaker_key, last_attempted_at, last_success_at, last_status, warning_count, warnings, metadata, last_attempt_id, last_success_attempt_id) VALUES (?, ?, 'breaker', ?, ?, 'error', 0, '[]', '{}', 'failed-latest', 'success')`).run(ASSET, coin.liveReservesConfig!.adapter, CLOCK, fetchedAt);
  const ids = [ASSET, "missing-member"];
  return { sqlite, db, identity, ids };
}

describe("producer-owned accepted reserve generations", () => {
  it("seals a complete metadata census with retained successes and explicit absence", async () => {
    const h = await harness();
    const accepted = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "degraded" }, CLOCK);
    expect(accepted?.members).toHaveLength(2);
    expect(accepted?.members[0]).toMatchObject({ stablecoinId: ASSET, snapshot: { attemptId: "success", sliceCount: 1 }, latestAttempt: { attemptId: "failed-latest", status: "error" } });
    expect(accepted?.members[1].snapshot).toBeNull();
    expect(h.sqlite.prepare("SELECT state, child_dispositions_json FROM worker_scheduled_checkpoints").get()).toMatchObject({ state: "running", child_dispositions_json: '{"sync-live-reserves":"completed"}' });
    const snapshot = accepted!.members[0].snapshot!;
    const full = { ...snapshot, slices: [{ name: "Cash", pct: 100, risk: "low" as const }] };
    expect(evaluateLiveReserveAdmission(snapshot, snapshot, coin, CLOCK)).toEqual(evaluateLiveReserveAdmission(full, snapshot, coin, CLOCK));
  });

  it.each([
    ["invocation_id = 'other'"], ["execution_generation = 2"], ["attempt_no = 2"], ["state = 'completed'"],
    ["queue_hash = 'other'"], ["items_total = 3"], ["items_done = 1"], ["next_item_key = 'pending'"],
    ["current_domain_attempt_id = 'pending'"], ["child_dispositions_json = '{\"sync-live-reserves\":\"failed\"}'"],
  ])("refuses changed ownership or incomplete frontier: %s", async (change) => {
    const h = await harness();
    h.sqlite.exec(`UPDATE worker_scheduled_checkpoints SET ${change}`);
    expect(await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK)).toBeNull();
    expect(h.sqlite.prepare("SELECT * FROM cache WHERE key = 'live-reserves:accepted-generation:v1'").get()).toBeUndefined();
  });

  it.each(["error", "skipped_locked", "skipped_neutral"] as const)("never seals an unsuccessful result: %s", async (status) => {
    const h = await harness();
    expect(await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status }, CLOCK)).toBeNull();
  });

  it("seals each root once and older compatible replay consumes retained newer acceptance", async () => {
    const h = await harness();
    const first = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    h.sqlite.prepare("UPDATE reserve_composition SET fetched_at = fetched_at + 1").run();
    const replay = await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK + 100);
    expect(replay).toEqual(first);
    const newer = await beginLiveReserveCheckpoint(h.db, { slotStartedAt: CLOCK + 14400, invocationId: "newer", nowSec: CLOCK });
    h.sqlite.prepare(`UPDATE worker_scheduled_checkpoints SET queue_hash = 'test', items_done = 2, items_total = 2, next_item_key = NULL, child_dispositions_json = '{"sync-live-reserves":"running"}' WHERE slot_started_at = ?`).run(newer.slotStartedAt);
    const latest = await sealAcceptedReserveGeneration(h.db, newer, "test", h.ids, { status: "ok" }, CLOCK + 14500);
    expect(await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK + 15000)).toEqual(latest);
  });

  it.each(["slices = 'invalid'", "metadata = 'invalid'", "warnings = '[{}]'", "adapter_evidence_class = 'invalid'"])("quarantines malformed members without losing the cohort: %s", async (change) => {
    const h = await harness();
    h.sqlite.exec(`UPDATE reserve_composition SET ${change}`);
    expect((await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))?.members[0].snapshot).toBeNull();
  });

  it("fails closed for absent, malformed and tampered envelopes", async () => {
    const h = await harness();
    await expect(loadAcceptedReserveGeneration(h.db)).rejects.toThrow("accepted-reserve-view-unavailable");
    await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK);
    h.sqlite.exec("UPDATE cache SET value = json_set(value, '$.producerCompletedAtSec', 1)");
    await expect(loadAcceptedReserveGeneration(h.db)).rejects.toThrow("accepted-reserve-view-invalid");
  });

  it("does not complete the producer child when acceptance persistence rolls back", async () => {
    const h = await harness();
    h.sqlite.exec("CREATE TRIGGER refuse_seal BEFORE INSERT ON cache BEGIN SELECT RAISE(ABORT, 'seal write failed'); END");
    await expect(sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK)).rejects.toThrow("seal write failed");
    expect(h.sqlite.prepare("SELECT child_dispositions_json FROM worker_scheduled_checkpoints").get()).toMatchObject({ child_dispositions_json: '{"sync-live-reserves":"running"}' });
  });

  it("reassesses consumed fetch clocks at the strict 48-hour boundary without renewing the run", async () => {
    const h = await harness(CLOCK, CLOCK - 48 * 3600 + 60);
    const accepted = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    const record = acceptedReserveMetadataMap(accepted, CLOCK).get(ASSET)!;
    const input = consumedReserveInput(accepted, ASSET, record);
    const entries = [{ stablecoinId: ASSET, reserveInput: input }] as RedemptionBackstopEntry[];
    const metadata = { reserveViewSchemaVersion: 1, reserveGenerationId: accepted.generationId, reserveContentSha256: accepted.contentSha256, runClockSec: CLOCK, consumedReserveInputs: { [ASSET]: input } };
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 59)).toBe("fresh");
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 60)).toBe("fresh");
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 61)).toBe("stale");
    expect(assessConsumedRedemptionReserves(entries, {}, CLOCK, CLOCK)).toBe("unavailable");
    expect(assessConsumedRedemptionReserves(entries, { ...metadata, consumedReserveInputs: {} }, CLOCK, CLOCK)).toBe("unavailable");
  });

  it("expires consumed source evidence independently of a fresh fetch and checks binding identity", async () => {
    const h = await harness(CLOCK, CLOCK - 60);
    const accepted = (await sealAcceptedReserveGeneration(h.db, h.identity, "test", h.ids, { status: "ok" }, CLOCK))!;
    const input = consumedReserveInput(accepted, ASSET, acceptedReserveMetadataMap(accepted, CLOCK).get(ASSET)!);
    const budget = assessReserveSnapshotFreshness({ fetchedAt: CLOCK - 60, attemptId: "success", metadata: {
      freshnessMode: "verified", sourceTimestamp: CLOCK - 60,
    } }, coin, CLOCK, 172800).sourceAgeBudgetSec!;
    input.freshness = assessReserveSnapshotFreshness({ fetchedAt: CLOCK - 60, attemptId: "success", metadata: {
      freshnessMode: "verified", sourceTimestamp: CLOCK - budget + 60,
    } }, coin, CLOCK, 172800);
    const entries = [{ stablecoinId: ASSET, reserveInput: input }] as RedemptionBackstopEntry[];
    const metadata = { reserveViewSchemaVersion: 1, reserveGenerationId: accepted.generationId, reserveContentSha256: accepted.contentSha256, runClockSec: CLOCK, consumedReserveInputs: { [ASSET]: input } };
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 60)).toBe("fresh");
    expect(assessConsumedRedemptionReserves(entries, metadata, CLOCK, CLOCK + 61)).toBe("stale");
    expect(assessConsumedRedemptionReserves(entries, { ...metadata, reserveGenerationId: "different" }, CLOCK, CLOCK)).toBe("unavailable");
    expect(assessConsumedRedemptionReserves(entries, { ...metadata, consumedReserveInputs: { [ASSET]: { ...input, configFingerprint: "b".repeat(64) } } }, CLOCK, CLOCK)).toBe("unavailable");
  });
});
