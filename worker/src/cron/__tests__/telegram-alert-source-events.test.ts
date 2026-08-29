import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { StablecoinsCacheLoadResult } from "../../lib/stablecoins-cache";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import type { TelegramDispatchEvents } from "../dispatch-telegram-events";
import type { RoutedSubscriberAlert } from "../dispatch-telegram-routing";
import {
  buildTelegramAlertSourceEvent,
  commitTelegramAlertSourceBaseline,
  completeTelegramAlertSourceEvent,
  expireTelegramAlertSourceEvent,
  loadOldestIncompleteTelegramAlertSourceEvent,
  loadTelegramAlertSourceEvent,
  persistTelegramAlertSourceEvent,
  resolveTelegramAlertSourcePresetPages,
  suppressIncomparableTelegramSafetySourceEvent,
} from "../telegram-alert-source-events";
import type { TelegramAlertSnapshots } from "../telegram-alert-snapshots";
import { materializeTelegramTargetPlanPage } from "../telegram-alert-target-plans";
import {
  loadHandledTelegramAlertItemsByChat,
  removeHandledTelegramAlertItems,
} from "../telegram-alert-event-lineage";

const NOW = 1_800_000_000;

const V8_IDENTITY = {
  model: "v8" as const,
  schemaVersion: 1 as const,
  methodologyVersion: "8.0-test",
  evaluationBuildDigest: "a".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
  publicationGenerationId: "report-cards:v8:1",
};

const V9_IDENTITY = {
  model: "v9" as const,
  schemaVersion: 1 as const,
  methodologyVersion: "candidate-v9.0",
  policyId: "safety-score-v9",
  policyDigest: "c".repeat(64),
  evaluationBuildDigest: "d".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}`,
  publicationGenerationId: "report-cards:v9:1",
};

interface Harness {
  sqlite: DatabaseSync;
  db: D1Database;
}

const openDatabases: DatabaseSync[] = [];

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

function createHarness(): Harness {
  const { sqlite, db } = createLatestSchemaSqlite();
  openDatabases.push(sqlite);
  return { sqlite, db };
}

function events(stablecoinIds = ["usdc-circle"]): TelegramDispatchEvents {
  return {
    dewsChanges: stablecoinIds.map((stablecoinId) => ({
      stablecoinId,
      symbol: stablecoinId === "usdc-circle" ? "USDC" : stablecoinId.toUpperCase(),
      oldBand: "CALM",
      newBand: "ALERT",
      score: 70,
      topSignals: [],
    })),
    depegTriggered: [],
    depegResolved: [],
    depegWorsening: [],
    safetyChanges: [],
    launchPromoted: [],
    reservePromoted: [],
    suppressedMethodologyChanges: 0,
    dewsIds: [...stablecoinIds],
    depegIds: [],
    safetyIds: [],
    launchIds: [],
    reserveIds: [],
  };
}

function baseline(stablecoinIds = ["usdc-circle"]): TelegramAlertSnapshots {
  return {
    dews: Object.fromEntries(stablecoinIds.map((id) => [id, "ALERT"])),
    dewsAlertable: Object.fromEntries(stablecoinIds.map((id) => [id, "ALERT"])),
    depeg: {},
    safety: null,
    launch: [],
    reserveDispatched: [],
  };
}

function stablecoinsResult(stablecoinIds = ["usdc-circle"]): StablecoinsCacheLoadResult {
  return {
    kind: "ok",
    updatedAt: NOW,
    payload: {
      peggedAssets: stablecoinIds.map((id) => ({
        id,
        symbol: id === "usdc-circle" ? "USDC" : id.toUpperCase(),
        name: id,
        pegType: "peggedUSD",
        price: 1,
        circulating: { peggedUSD: 50_000_000_000 },
      })),
    },
  } as unknown as StablecoinsCacheLoadResult;
}

async function persistedSource(harness: Harness, stablecoinIds = ["usdc-circle"], detectedAt = NOW) {
  return persistTelegramAlertSourceEvent(
    harness.db,
    await buildTelegramAlertSourceEvent({
      events: events(stablecoinIds),
      baseline: baseline(stablecoinIds),
      detectedAt,
    }),
  );
}

function insertPresetFollower(
  sqlite: DatabaseSync,
  chatId: string,
  options: { enabled?: boolean; snoozeUntil?: number | null } = {},
): void {
  sqlite.prepare(
    `INSERT INTO telegram_subscribers (
       chat_id, created_at, last_active_at, alert_snooze_until_ts,
       quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc, timezone
     ) VALUES (?, ?, ?, ?, 1, 22, 6, 'Europe/Belgrade')`,
  ).run(chatId, NOW, NOW, options.snoozeUntil ?? null);
  sqlite.prepare(
    `INSERT INTO telegram_preset_subscriptions (
       chat_id, preset_id, alert_dews, depeg_worsening_bps_step, created_at, updated_at
     ) VALUES (?, 'usd-top25', ?, 75, ?, ?)`,
  ).run(chatId, options.enabled === false ? 0 : 1, NOW, NOW);
}

describe("Telegram alert source-event resolution", () => {
  it("suppresses stale queued safety work at a model boundary while preserving other families", async () => {
    const source = await buildTelegramAlertSourceEvent({
      events: {
        ...events(),
        safetyChanges: [{
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          oldGrade: "B",
          newGrade: "A",
          oldScore: 78,
          newScore: 91,
        }],
        safetyIds: ["usdc-circle"],
        safetyScoreIdentity: V8_IDENTITY,
      },
      baseline: {
        ...baseline(),
        safety: {
          generation: "safety-8.0-test-alert-source-v1",
          safetyScoreIdentity: V8_IDENTITY,
          snapshot: {
            "usdc-circle": { grade: "A", score: 91, methodologyVersion: "8.0-test" },
          },
        },
      },
      detectedAt: NOW,
    });

    const reconciled = suppressIncomparableTelegramSafetySourceEvent(source, {
      generation: "safety-v9-candidate-v9.0-alert-source-v1",
      safetyScoreIdentity: V9_IDENTITY,
      snapshot: {
        "usdc-circle": { grade: "B-", score: 80, methodologyVersion: "candidate-v9.0" },
      },
    });

    expect(reconciled.events.dewsChanges).toHaveLength(1);
    expect(reconciled.events.dewsIds).toEqual(["usdc-circle"]);
    expect(reconciled.events.safetyChanges).toEqual([]);
    expect(reconciled.events.safetyIds).toEqual([]);
    expect(reconciled.events.safetyScoreIdentity).toBeNull();
    expect(reconciled.baseline.safety?.safetyScoreIdentity).toEqual(V9_IDENTITY);
  });

  it("rejects newly persisted safety events without model provenance", async () => {
    await expect(buildTelegramAlertSourceEvent({
      events: {
        ...events(),
        safetyChanges: [{
          stablecoinId: "usdc-circle",
          symbol: "USDC",
          oldGrade: "B",
          newGrade: "A",
          oldScore: 78,
          newScore: 91,
        }],
        safetyIds: ["usdc-circle"],
      },
      baseline: baseline(),
      detectedAt: NOW,
    })).rejects.toThrow("exact Safety Score identity");
  });

  it("holds the baseline through preset resolution failure and resumes the immutable event", async () => {
    const harness = createHarness();
    insertPresetFollower(harness.sqlite, "preset-chat");
    const source = await persistedSource(harness);

    const failed = await resolveTelegramAlertSourcePresetPages(harness.db, source, NOW, {
      getStablecoinsCacheResult: async () => ({ kind: "error", reason: "missing-cache", updatedAt: null }),
    });
    expect(failed.allComplete).toBe(false);
    expect(failed.resolutionFailures).toBe(1);
    expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
    expect((await loadOldestIncompleteTelegramAlertSourceEvent(harness.db))?.sourceEventId)
      .toBe(source.sourceEventId);

    const recovered = await resolveTelegramAlertSourcePresetPages(harness.db, source, NOW + 60, {
      getStablecoinsCacheResult: async () => stablecoinsResult(),
    });
    expect(recovered.allComplete).toBe(true);
    expect(recovered.presetResults.dews.kind).toBe("ok");
    if (recovered.presetResults.dews.kind === "ok") {
      expect(recovered.presetResults.dews.rows.get("usdc-circle")?.map((row) => row.chat_id))
        .toEqual(["preset-chat"]);
    }

    await commitTelegramAlertSourceBaseline(harness.db, source, NOW + 61);
    await completeTelegramAlertSourceEvent(harness.db, source.sourceEventId, NOW + 62);
    expect((await loadTelegramAlertSourceEvent(harness.db, source.sourceEventId))?.status).toBe("complete");
    expect(harness.sqlite.prepare("SELECT value FROM cache WHERE key = 'alert:dews-snapshot'").get())
      .toEqual({ value: JSON.stringify({ "usdc-circle": "ALERT" }) });
  });

  it("persists bounded follower pages and resumes only the next cursor page", async () => {
    const harness = createHarness();
    for (let index = 0; index < 105; index += 1) {
      insertPresetFollower(harness.sqlite, `chat-${String(index).padStart(3, "0")}`);
    }
    const source = await persistedSource(harness);

    const first = await resolveTelegramAlertSourcePresetPages(harness.db, source, NOW, {
      getStablecoinsCacheResult: async () => stablecoinsResult(),
    });
    expect(first.allComplete).toBe(false);
    expect(first.pendingPages).toBe(1);
    expect(harness.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM telegram_alert_source_resolution_targets",
    ).get()).toEqual({ count: 100 });

    const second = await resolveTelegramAlertSourcePresetPages(harness.db, source, NOW + 60, {
      getStablecoinsCacheResult: async () => {
        throw new Error("completed membership resolution must not be repeated");
      },
    });
    expect(second.allComplete).toBe(true);
    expect(harness.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM telegram_alert_source_resolution_targets",
    ).get()).toEqual({ count: 105 });
    expect(harness.sqlite.prepare(
      `SELECT page_index, status FROM telegram_alert_source_resolution_pages
        WHERE source_event_id = ? ORDER BY page_index`,
    ).all(source.sourceEventId)).toEqual([
      { page_index: 0, status: "complete" },
      { page_index: 1, status: "complete" },
    ]);
  });

  it("leaves a page pending after a normalized-target batch fault and safely re-queries it", async () => {
    const harness = createHarness();
    insertPresetFollower(harness.sqlite, "preset-chat");
    const source = await persistedSource(harness);
    let batchCalls = 0;
    const faultDb = {
      ...harness.db,
      batch: async <T>(statements: D1PreparedStatement[]) => {
        batchCalls += 1;
        if (batchCalls === 2) throw new Error("injected follower-page write failure");
        return harness.db.batch<T>(statements);
      },
    } as D1Database;

    const failed = await resolveTelegramAlertSourcePresetPages(faultDb, source, NOW, {
      getStablecoinsCacheResult: async () => stablecoinsResult(),
    });
    expect(failed.allComplete).toBe(false);
    expect(failed.queryFailures).toBe(1);
    expect(harness.sqlite.prepare(
      "SELECT status, last_error_class FROM telegram_alert_source_resolution_pages WHERE source_event_id = ?",
    ).get(source.sourceEventId)).toEqual({ status: "pending", last_error_class: "persistence_failed" });
    expect(harness.sqlite.prepare(
      "SELECT COUNT(*) AS count FROM telegram_alert_source_resolution_targets",
    ).get()).toEqual({ count: 0 });

    const recovered = await resolveTelegramAlertSourcePresetPages(harness.db, source, NOW + 60, {
      getStablecoinsCacheResult: async () => {
        throw new Error("persisted memberships must be reused after the page-write fault");
      },
    });
    expect(recovered.allComplete).toBe(true);
    if (recovered.presetResults.dews.kind !== "ok") throw new Error("expected recovered DEWS page");
    expect(recovered.presetResults.dews.rows.get("usdc-circle")?.map((row) => row.chat_id))
      .toEqual(["preset-chat"]);
  });

  it("revalidates unfollow, family-off, snooze, and forget before recovered routing", async () => {
    const harness = createHarness();
    for (const chatId of ["active", "unfollowed", "family-off", "snoozed", "forgotten"]) {
      insertPresetFollower(harness.sqlite, chatId);
    }
    const source = await persistedSource(harness);
    const initial = await resolveTelegramAlertSourcePresetPages(harness.db, source, NOW, {
      getStablecoinsCacheResult: async () => stablecoinsResult(),
    });
    expect(initial.allComplete).toBe(true);

    harness.sqlite.prepare(
      "DELETE FROM telegram_preset_subscriptions WHERE chat_id = 'unfollowed'",
    ).run();
    harness.sqlite.prepare(
      "UPDATE telegram_preset_subscriptions SET alert_dews = 0 WHERE chat_id = 'family-off'",
    ).run();
    harness.sqlite.prepare(
      "UPDATE telegram_subscribers SET alert_snooze_until_ts = ? WHERE chat_id = 'snoozed'",
    ).run(NOW + 3_600);
    harness.sqlite.prepare("DELETE FROM telegram_subscribers WHERE chat_id = 'forgotten'").run();
    harness.sqlite.prepare(
      "DELETE FROM telegram_preset_subscriptions WHERE chat_id = 'forgotten'",
    ).run();

    const revalidated = await resolveTelegramAlertSourcePresetPages(harness.db, source, NOW + 60, {
      getStablecoinsCacheResult: async () => {
        throw new Error("completed pages must use normalized lineage");
      },
    });
    if (revalidated.presetResults.dews.kind !== "ok") throw new Error("expected completed DEWS pages");
    expect(revalidated.presetResults.dews.rows.get("usdc-circle")?.map((row) => row.chat_id))
      .toEqual(["active"]);
  });

  it("subtracts handled direct/global source items while preserving missing preset items", async () => {
    const harness = createHarness();
    const source = await persistedSource(harness, ["usdc-circle", "dai-makerdao"]);
    const routed = (chatId: string): RoutedSubscriberAlert => ({
      chatId,
      lastActiveAt: NOW,
      alerts: {
        dews: [events(["usdc-circle"]).dewsChanges[0]],
        depegTriggered: [],
        depegResolved: [],
        depegWorsening: [],
        safety: [],
        launch: [],
        reserve: [],
      },
      canonicalHtml: `<b>${chatId}: USDC</b>`,
      chunks: [`<b>${chatId}: USDC</b>`],
      disableNotification: false,
      alertType: "dews",
    });
    const owner = "lineage-test";
    harness.sqlite.prepare(
      `UPDATE telegram_alert_source_events
          SET status = 'planned', target_plan_state = 'planning',
              target_plan_owner = ?, target_plan_claim_expires_at = ?
        WHERE source_event_id = ?`,
    ).run(owner, NOW + 120, source.sourceEventId);
    const claim = {
      sourceEventId: source.sourceEventId,
      owner,
      generation: 0,
      state: "planning" as const,
      detectedAt: source.detectedAt,
      expiresAt: source.expiresAt,
      horizonAt: NOW,
      highWaterChatId: null,
      subscriberCursorChatId: null,
      planningCursorChatId: null,
    };
    const authoritativeRoutes = [routed("direct-chat"), routed("global-chat")].map((entry) => ({
      ...entry,
      sourceEventId: source.sourceEventId,
      preferenceGeneration: 0,
      alertScope: [{ stablecoinId: "usdc-circle", family: "dews" as const }],
    }));
    await materializeTelegramTargetPlanPage(
      harness.db,
      claim,
      0,
      authoritativeRoutes.map((entry) => ({
        subscriber: {
          chatId: entry.chatId,
          preferenceGeneration: 0,
          lastActiveAt: entry.lastActiveAt,
          initiallyEligible: true,
        },
        currentPreferenceGeneration: 0,
        currentEligible: true,
        routed: [entry],
      })),
      NOW,
    );
    harness.sqlite.prepare(
      `UPDATE telegram_alert_job_targets
          SET status = 'sent', effect_state = 'complete', sent_at = ?,
              final_delivery_state = 'accepted', final_delivery_at = ?
        WHERE source_event_id = ?`,
    ).run(NOW, NOW, source.sourceEventId);

    const handled = await loadHandledTelegramAlertItemsByChat(harness.db, source.sourceEventId);
    expect(handled.get("direct-chat")).toEqual(new Set(["dews:usdc-circle"]));
    expect(handled.get("global-chat")).toEqual(new Set(["dews:usdc-circle"]));
    expect(handled.get("direct-chat")?.has("dews:dai-makerdao")).toBe(false);

    const pending = new Map([
      [
        "direct-chat",
        {
          lastActiveAt: NOW,
          alerts: {
            dews: events(["usdc-circle", "dai-makerdao"]).dewsChanges,
            depegTriggered: [],
            depegResolved: [],
            depegWorsening: [],
            safety: [],
            launch: [],
            reserve: [],
          },
          quietHoursEnabled: false,
          quietHoursStartUtc: null,
          quietHoursEndUtc: null,
          timezone: null,
          specificCount: 2,
          globalCount: 0,
        },
      ],
    ]);
    expect(removeHandledTelegramAlertItems(pending, handled)).toBe(1);
    expect(pending.get("direct-chat")?.alerts.dews.map((event) => event.stablecoinId))
      .toEqual(["dai-makerdao"]);
  });

  it("commits snapshots and the baseline marker atomically at every statement boundary", async () => {
    const expectedBatchStatements = 6;
    for (let failAt = 0; failAt < expectedBatchStatements; failAt += 1) {
      const harness = createHarness();
      const source = await persistedSource(harness);
      harness.sqlite.prepare(
        "UPDATE telegram_alert_source_events SET status = 'planned' WHERE source_event_id = ?",
      ).run(source.sourceEventId);
      const base = createSqliteD1(harness.sqlite);
      const failingDb = {
        ...base,
        batch: async <T>(statements: D1PreparedStatement[]) => {
          harness.sqlite.exec("BEGIN IMMEDIATE");
          try {
            const results: D1Result<T>[] = [];
            for (let index = 0; index < statements.length; index += 1) {
              if (index === failAt) throw new Error(`fault-${failAt}`);
              results.push(await statements[index].run<T>());
            }
            harness.sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            harness.sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      } as D1Database;

      await expect(commitTelegramAlertSourceBaseline(failingDb, source, NOW + 1))
        .rejects.toThrow(`fault-${failAt}`);
      expect(harness.sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 0 });
      expect(harness.sqlite.prepare(
        "SELECT status FROM telegram_alert_source_events WHERE source_event_id = ?",
      ).get(source.sourceEventId)).toEqual({ status: "planned" });
    }

    const harness = createHarness();
    const source = await persistedSource(harness);
    harness.sqlite.prepare(
      "UPDATE telegram_alert_source_events SET status = 'planned' WHERE source_event_id = ?",
    ).run(source.sourceEventId);
    await commitTelegramAlertSourceBaseline(harness.db, source, NOW + 1);
    expect((await loadTelegramAlertSourceEvent(harness.db, source.sourceEventId))?.status)
      .toBe("baseline_committed");
    await completeTelegramAlertSourceEvent(harness.db, source.sourceEventId, NOW + 2);
    expect((await loadOldestIncompleteTelegramAlertSourceEvent(harness.db))).toBeNull();
  });

  it("expires stale unresolved work, advances its stored baseline, and unblocks newer detection", async () => {
    const harness = createHarness();
    const source = await persistedSource(harness, ["usdc-circle"], NOW - 100_000);
    harness.sqlite.prepare(
      `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at
       ) VALUES ('job-stale', 'dews', ?, 'risk', ?, ?)`,
    ).run(source.sourceEventId, source.detectedAt, source.expiresAt);
    harness.sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, alert_type, pending_dedupe_key, created_at
       ) VALUES ('job-stale', 'key-stale', 'chat-stale', 'dews', 'key-stale', ?)`,
    ).run(source.detectedAt);

    await expireTelegramAlertSourceEvent(harness.db, source, NOW);

    expect((await loadTelegramAlertSourceEvent(harness.db, source.sourceEventId))?.status).toBe("expired");
    expect(await loadOldestIncompleteTelegramAlertSourceEvent(harness.db)).toBeNull();
    expect(harness.sqlite.prepare(
      "SELECT status, error_class FROM telegram_alert_job_targets WHERE job_id = 'job-stale'",
    ).get()).toEqual({ status: "expired", error_class: "source_event_expired" });
    expect(harness.sqlite.prepare(
      "SELECT status, last_error_class FROM telegram_alert_source_resolution_pages WHERE source_event_id = ?",
    ).get(source.sourceEventId)).toEqual({ status: "expired", last_error_class: "source_event_expired" });
    expect(harness.sqlite.prepare("SELECT value FROM cache WHERE key = 'alert:dews-snapshot'").get())
      .toEqual({ value: JSON.stringify({ "usdc-circle": "ALERT" }) });
  });
});
