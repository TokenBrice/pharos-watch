import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { emptyAlerts, type RoutedSubscriberAlert } from "../../dispatch/dispatch-telegram-routing";
import { captureTelegramPlanningSubscriberPage, loadTelegramPlanningSubscriberPage } from "../horizon";
import { claimTelegramTargetPlanning, expireTelegramTargetPlanSource } from "../source-state";
import { enqueueTelegramAuthoritativeTargets, expireTelegramAuthoritativeTargets, finalizeTelegramTargetPlanning, openTelegramTargetPlanDelivery } from "../delivery";
import { materializeTelegramTargetPlanPage, reconcileIncompleteTelegramTargetPlanPage } from "../materialization";
import { runTelegramTargetPlanCoordinator } from "../coordinator";
import { type TelegramPlanningDecision, type TelegramTargetPlanningClaim } from "../types";
import {
  executeAuthoritativeFanoutPath,
  hasDeferredTelegramAuthoritativeWork,
} from "../../dispatch/dispatch-telegram-authoritative-path";
import {
  reconcileTelegramAlertJobCounters,
  reconcileTelegramJobTargetFinalDeliveryFromPending,
  recordTelegramJobTargetFinalDelivery,
} from "../../delivery/telegram-alert-job-target-outcomes";
import {
  expireTelegramAlertSourceEvent,
  loadTelegramAlertSourceEvent,
} from "../../sources/telegram-alert-source-events";
import { resolveTelegramAlertSourcePresetPages } from "../../sources/telegram-alert-source-memberships";
import { PENDING_TTL_SEC } from "@shared/lib/telegram-delivery-policy";
import { resolveTelegramTargetExpiresAt } from "../materialization";
import { insertTelegramSubscriber } from "../../dispatch/__tests__/telegram-subscriber.test-support";
import { loadTelegramPendingCapacity } from "../../../../telegram/outbox/pending-capacity";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "../../../../lib/safety-score-v9/consumer-freshness";
import { recordTelegramAlertTargetStatuses, recordTelegramAlertTargetCancellations } from "../../delivery/telegram-alert-target-status";
import { sha256Hex } from "../../../../lib/hash";
import type { PersistedTelegramTargetPlanV1 } from "../telegram-alert-target-plan-contract";

const NOW = 1_800_000_000;
const { open: setupLatestSchema, closeAll } = createLatestSchemaFixtureTracker();
afterEach(closeAll);

const EMPTY_EVENTS = JSON.stringify({
  dewsChanges: [],
  depegTriggered: [],
  depegResolved: [],
  depegWorsening: [],
  safetyChanges: [],
  launchPromoted: [],
  reservePromoted: [],
  suppressedMethodologyChanges: 0,
  dewsIds: [],
  depegIds: [],
  safetyIds: [],
  launchIds: [],
  reserveIds: [],
});
const EMPTY_BASELINE = JSON.stringify({
  dews: {},
  dewsAlertable: {},
  depeg: {},
  safety: {},
  launch: [],
  reserveDispatched: [],
});

function insertSource(
  sqlite: DatabaseSync,
  sourceEventId: string,
  options: { expiresAt?: number; state?: string; generation?: number; owner?: string } = {},
): void {
  sqlite
    .prepare(
      `INSERT INTO telegram_alert_source_events (
       source_event_id, schema_version, status, detected_at, expires_at,
       event_payload, baseline_payload, target_plan_state,
       target_plan_generation, target_plan_owner
     ) VALUES (?, 1, 'planned', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      sourceEventId,
      NOW,
      options.expiresAt ?? NOW + 7_200,
      EMPTY_EVENTS,
      EMPTY_BASELINE,
      options.state ?? "unstarted",
      options.generation ?? 0,
      options.owner ?? null,
    );
}

function insertSubscriber(sqlite: DatabaseSync, chatId: string, generation = 1, createdAt = NOW - 100): void {
  insertTelegramSubscriber(sqlite, {
    chatId,
    createdAt,
    lastActiveAt: NOW - 10,
    preferenceGeneration: generation,
  });
}

function routed(
  chatId: string,
  sourceEventId: string,
  preferenceGeneration: number,
  suffix = "",
  chunks = 1,
): RoutedSubscriberAlert {
  const alerts = emptyAlerts();
  alerts.dews.push({
    stablecoinId: `usdc-circle${suffix}`,
    symbol: "USDC",
    oldBand: "CALM",
    newBand: "WARNING",
    score: 70,
    topSignals: [],
  });
  const canonicalHtml = `<b>USDC</b> warning${suffix}`;
  return {
    chatId,
    lastActiveAt: NOW - 10,
    alerts,
    canonicalHtml,
    chunks: Array.from({ length: chunks }, (_, index) => `${canonicalHtml} ${index + 1}`),
    disableNotification: false,
    alertType: "dews",
    sourceEventId,
    preferenceGeneration,
    alertScope: [{ stablecoinId: `usdc-circle${suffix}`, family: "dews" }],
  };
}

async function captureClaim(
  db: D1Database,
  sourceEventId: string,
  eligibility: ReadonlyMap<string, boolean>,
  owner = "test-owner",
): Promise<TelegramTargetPlanningClaim> {
  const initial = await claimTelegramTargetPlanning(db, sourceEventId, NOW, owner);
  if (!initial) throw new Error("claim missing");
  await captureTelegramPlanningSubscriberPage(
    db,
    initial,
    NOW,
    async (subscribers) =>
      new Map(
        subscribers.map((subscriber) => [
          subscriber.chatId,
          {
            eligible: eligibility.get(subscriber.chatId) ?? false,
            observedPreferenceGeneration: subscriber.preferenceGeneration,
          },
        ]),
      ),
  );
  const captured = await claimTelegramTargetPlanning(db, sourceEventId, NOW, owner);
  if (!captured) throw new Error("captured claim missing");
  return captured;
}

async function openDeliveryForRoutes(
  db: D1Database,
  sourceEventId: string,
  routes: ReadonlyMap<string, readonly RoutedSubscriberAlert[]>,
): Promise<void> {
  const eligibility = new Map([...routes].map(([chatId, alerts]) => [chatId, alerts.length > 0]));
  const claim = await captureClaim(db, sourceEventId, eligibility);
  const subscribers = await loadTelegramPlanningSubscriberPage(db, claim);
  await materializeTelegramTargetPlanPage(
    db,
    claim,
    0,
    subscribers.map((subscriber) => ({
      subscriber,
      currentPreferenceGeneration: subscriber.preferenceGeneration,
      currentEligible: (routes.get(subscriber.chatId)?.length ?? 0) > 0,
      routed: routes.get(subscriber.chatId) ?? [],
    })),
    NOW,
  );
  await finalizeTelegramTargetPlanning(db, claim, NOW);
  await openTelegramTargetPlanDelivery(db, claim, NOW);
}

// Seed exact retained v3 evidence, including its digest-derived plan identity.
// This is fixture construction only; runtime recovery must never rewrite it.
async function seedRetainedV3Plans(sqlite: DatabaseSync): Promise<unknown[]> {
  const plans = sqlite.prepare("SELECT plan_key, plan_payload_json FROM telegram_alert_target_plans")
    .all() as Array<{ plan_key: string; plan_payload_json: string }>;
  for (const row of plans) {
    const payload = JSON.parse(row.plan_payload_json) as PersistedTelegramTargetPlanV1;
    for (const message of payload.messages) {
      const oldKey = message.targetKey;
      message.targetKey = oldKey.replace(":v4:", ":v3:");
      sqlite.prepare(`UPDATE telegram_alert_job_targets SET target_key = ?, pending_dedupe_key = ?
        WHERE plan_key = ? AND target_key = ?`).run(message.targetKey, message.targetKey, row.plan_key, oldKey);
      sqlite.prepare("UPDATE telegram_alert_job_target_items SET target_key = ? WHERE target_key = ?")
        .run(message.targetKey, oldKey);
    }
    const json = JSON.stringify(payload);
    const digest = await sha256Hex(json);
    const key = `${payload.chatId}:${payload.alertType}:${digest.slice(0, 32)}`;
    sqlite.prepare(`UPDATE telegram_alert_target_plans SET plan_key = ?, plan_payload_json = ?,
      plan_payload_digest = ? WHERE plan_key = ?`).run(key, json, digest, row.plan_key);
    for (const table of ["telegram_alert_job_targets", "telegram_alert_target_plan_items"]) {
      sqlite.prepare(`UPDATE ${table} SET plan_key = ? WHERE plan_key = ?`).run(key, row.plan_key);
    }
  }
  return sqlite.prepare(`SELECT plan_key, plan_payload_json, plan_payload_digest
    FROM telegram_alert_target_plans ORDER BY plan_ordinal`).all();
}

describe("authoritative Telegram target plans on latest SQLite schema", () => {
  it("uses the strictest family TTL for a mixed consolidated target", () => {
    expect(
      resolveTelegramTargetExpiresAt({ detectedAt: NOW }, { alertType: "depeg", alertTypes: ["depeg", "launch"] }),
    ).toBe(NOW + 90 * 60);
  });
  it("materializes every target before pending handoff and preserves job metadata", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:full";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");

    const firstOwner = await claimTelegramTargetPlanning(db, sourceEventId, NOW, "owner-a");
    expect(firstOwner?.state).toBe("capturing");
    await expect(claimTelegramTargetPlanning(db, sourceEventId, NOW, "owner-b")).resolves.toBeNull();
    await captureTelegramPlanningSubscriberPage(
      db,
      firstOwner!,
      NOW,
      async (subscribers) =>
        new Map(
          subscribers.map((subscriber) => [
            subscriber.chatId,
            {
              eligible: true,
              observedPreferenceGeneration: subscriber.preferenceGeneration,
            },
          ]),
        ),
    );
    const claim = (await claimTelegramTargetPlanning(db, sourceEventId, NOW, "owner-a"))!;
    const [subscriber] = await loadTelegramPlanningSubscriberPage(db, claim);
    await materializeTelegramTargetPlanPage(
      db,
      claim,
      0,
      [
        {
          subscriber,
          currentPreferenceGeneration: 1,
          currentEligible: true,
          routed: [routed("42", sourceEventId, 1)],
        },
      ],
      NOW,
    );
    await finalizeTelegramTargetPlanning(db, claim, NOW);
    await openTelegramTargetPlanDelivery(db, claim, NOW);
    const handoff = await enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW);

    expect(handoff).toMatchObject({ enqueued: 1, remaining: 0 });
    expect(
      sqlite
        .prepare("SELECT status, pending_dedupe_key FROM telegram_alert_job_targets WHERE source_event_id = ?")
        .get(sourceEventId),
    ).toMatchObject({ status: "queued" });
    expect(sqlite.prepare("SELECT source_event_id, preference_generation FROM telegram_pending_alerts").get()).toEqual({
      source_event_id: sourceEventId,
      preference_generation: 1,
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM telegram_alert_target_plan_items WHERE source_event_id = ?")
        .get(sourceEventId),
    ).toEqual({ count: 1 });
    const metadata = sqlite
      .prepare("SELECT metadata FROM telegram_alert_jobs WHERE source_event_id = ?")
      .get(sourceEventId) as { metadata: string };
    expect(JSON.parse(metadata.metadata)).toMatchObject({
      rolloutStage: "authoritative-target-plan",
      countersSource: "authoritative-target-rows",
    });
    await expect(enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW)).resolves.toMatchObject({
      enqueued: 0,
      remaining: 0,
    });
  });

  it("hands off retained v3 delivery_open plans with exact stored payloads and keys", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:retained-v3-handoff";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    await openDeliveryForRoutes(db, sourceEventId, new Map([
      ["42", [routed("42", sourceEventId, 1, "", 2)]],
    ]));
    const retained = await seedRetainedV3Plans(sqlite);
    const expected = sqlite.prepare(`SELECT pending_dedupe_key AS dedupe_key, message_html
      FROM telegram_alert_job_targets ORDER BY chunk_index`).all();
    expect(expected).toHaveLength(2);
    expect(sqlite.prepare("SELECT target_plan_state FROM telegram_alert_source_events").get())
      .toEqual({ target_plan_state: "delivery_open" });
    await expect(enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW + 1))
      .resolves.toMatchObject({ enqueued: 2, remaining: 0 });
    expect(sqlite.prepare(`SELECT dedupe_key, message_html FROM telegram_pending_alerts ORDER BY chunk_index`).all())
      .toEqual(expected);
    expect(sqlite.prepare(`SELECT plan_key, plan_payload_json, plan_payload_digest
      FROM telegram_alert_target_plans ORDER BY plan_ordinal`).all()).toEqual(retained);
    await expect(enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW + 2))
      .resolves.toMatchObject({ enqueued: 0, remaining: 0 });
  });

  it("packs a target page into bounded D1 transactions", async () => {
    const { sqlite, db: baseDb } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:batched-page";
    const chatIds = Array.from({ length: 40 }, (_, index) => String(index + 1).padStart(3, "0"));
    insertSource(sqlite, sourceEventId);
    for (const chatId of chatIds) insertSubscriber(sqlite, chatId);
    const claim = await captureClaim(
      baseDb,
      sourceEventId,
      new Map(chatIds.map((chatId) => [chatId, true])),
    );
    const subscribers = await loadTelegramPlanningSubscriberPage(baseDb, claim);
    let batchCalls = 0;
    const db = {
      ...baseDb,
      batch: async (statements: D1PreparedStatement[]) => {
        batchCalls += 1;
        return baseDb.batch(statements);
      },
    } as D1Database;

    await materializeTelegramTargetPlanPage(
      db,
      claim,
      0,
      subscribers.map((subscriber) => ({
        subscriber,
        currentPreferenceGeneration: 1,
        currentEligible: true,
        routed: [routed(subscriber.chatId, sourceEventId, 1, `-${subscriber.chatId}`)],
      })),
      NOW,
    );

    expect(batchCalls).toBe(3);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_target_plans").get()).toEqual({ count: 40 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets").get()).toEqual({ count: 40 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_target_plan_items").get()).toEqual({ count: 40 });
  });

  it.each([
    { change: "unchanged", plans: 30, targets: 30 },
    { change: "unsubscribe", plans: 29, targets: 29 },
    { change: "snooze", plans: 29, targets: 29 },
    { change: "fewer chunks", plans: 30, targets: 30 },
    { change: "v3 retained", plans: 30, targets: 50 },
  ])("resumes the untouched page suffix after a packed D1 batch fails: $change", async ({ change, plans, targets }) => {
    const { sqlite, db: baseDb } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:batched-page-retry";
    const chatIds = Array.from({ length: 30 }, (_, index) => String(index + 1).padStart(3, "0"));
    insertSource(sqlite, sourceEventId);
    for (const chatId of chatIds) insertSubscriber(sqlite, chatId);
    const claim = await captureClaim(
      baseDb,
      sourceEventId,
      new Map(chatIds.map((chatId) => [chatId, true])),
    );
    const subscribers = await loadTelegramPlanningSubscriberPage(baseDb, claim);
    let rejectSuffixBatch = true;
    const failingDb = {
      ...baseDb,
      batch: async (statements: D1PreparedStatement[]) => {
        if (rejectSuffixBatch && statements.length === 50) {
          throw new Error("injected packed batch failure");
        }
        return baseDb.batch(statements);
      },
    } as D1Database;
    const decisions = subscribers.map((subscriber) => ({
      subscriber,
      currentPreferenceGeneration: 1,
      currentEligible: true,
      routed: [routed(subscriber.chatId, sourceEventId, 1, `-${subscriber.chatId}`,
        (change === "fewer chunks" && subscriber.chatId === "030")
          || (change === "v3 retained" && subscriber.chatId <= "020") ? 2 : 1)],
    }));

    await expect(
      materializeTelegramTargetPlanPage(failingDb, claim, 0, decisions, NOW),
    ).rejects.toThrow("injected packed batch failure");
    rejectSuffixBatch = false;

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_target_plans").get()).toEqual({ count: 20 });
    const retainedV3 = change === "v3 retained" ? await seedRetainedV3Plans(sqlite) : null;
    const retainedPlans = sqlite.prepare(`SELECT * FROM telegram_alert_target_plans
      WHERE plan_ordinal < 20 ORDER BY plan_ordinal`).all();
    const retainedItems = sqlite.prepare(`SELECT * FROM telegram_alert_target_plan_items
      ORDER BY plan_key, item_key`).all();
    const incomplete = await reconcileIncompleteTelegramTargetPlanPage(baseDb, claim, NOW + 1);
    expect(incomplete).toMatchObject({ found: true, complete: false, pageIndex: 0 });
    const remainder = await loadTelegramPlanningSubscriberPage(baseDb, claim, 90, {
      firstChatId: incomplete.firstChatId!,
      lastChatId: incomplete.lastChatId!,
    });
    expect(remainder).toHaveLength(10);
    expect(remainder.map((subscriber) => subscriber.chatId)).toEqual(chatIds.slice(20));
    const withdrawn = change === "unsubscribe" || change === "snooze";
    if (withdrawn) {
      sqlite.prepare(`UPDATE telegram_subscribers SET preference_generation = 2, alert_snooze_until_ts = ?
        WHERE chat_id = '030'`).run(change === "snooze" ? NOW + 3_600 : null);
    }

    await materializeTelegramTargetPlanPage(
      baseDb,
      claim,
      0,
      remainder.map((subscriber) => ({
        subscriber,
        currentPreferenceGeneration: withdrawn && subscriber.chatId === "030" ? 2 : 1,
        currentEligible: !(withdrawn && subscriber.chatId === "030"),
        routed: withdrawn && subscriber.chatId === "030"
          ? [] : [routed(subscriber.chatId, sourceEventId, 1, `-${subscriber.chatId}`)],
      })),
      NOW + 1,
    );
    expect(sqlite.prepare(`SELECT * FROM telegram_alert_target_plans
      WHERE plan_ordinal < 20 ORDER BY plan_ordinal`).all()).toEqual(retainedPlans);
    expect(sqlite.prepare(`SELECT * FROM telegram_alert_target_plan_items
      WHERE plan_key IN (SELECT plan_key FROM telegram_alert_target_plans WHERE plan_ordinal < 20)
      ORDER BY plan_key, item_key`).all()).toEqual(retainedItems);

    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS plans, COUNT(DISTINCT plan_ordinal) AS ordinals
             FROM telegram_alert_target_plans`,
        )
        .get(),
    ).toEqual({ plans, ordinals: plans });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets").get()).toEqual({ count: targets });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_target_plan_items").get()).toEqual({ count: plans });
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count FROM telegram_alert_planning_subscribers
            WHERE planning_outcome = 'pending'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT status FROM telegram_alert_target_plan_pages").get()).toEqual({ status: "complete" });
    expect(sqlite.prepare(`SELECT expected_plan_count, materialized_plan_count,
      expected_target_count, materialized_target_count FROM telegram_alert_target_plan_pages`).get())
      .toEqual({ expected_plan_count: plans, materialized_plan_count: plans,
        expected_target_count: targets, materialized_target_count: targets });
    expect(sqlite.prepare(`SELECT COUNT(*) AS finalized,
      SUM(planning_outcome = 'target_planned') AS planned
      FROM telegram_alert_planning_subscribers WHERE planning_outcome <> 'pending'`).get())
      .toEqual({ finalized: 30, planned: plans });
    await finalizeTelegramTargetPlanning(baseDb, claim, NOW + 1);
    expect(await openTelegramTargetPlanDelivery(baseDb, claim, NOW + 1)).toBe(true);
    const firstHandoff = await enqueueTelegramAuthoritativeTargets(baseDb, sourceEventId, 1, NOW + 1);
    if (retainedV3) {
      expect(firstHandoff).toMatchObject({ enqueued: 45, remaining: 5 });
      expect(await enqueueTelegramAuthoritativeTargets(baseDb, sourceEventId, 1, NOW + 2))
        .toMatchObject({ enqueued: 5, remaining: 0 });
    } else {
      expect(firstHandoff).toMatchObject({ enqueued: targets, remaining: 0 });
    }
    if (retainedV3) {
      expect(sqlite.prepare(`SELECT plan_key, plan_payload_json, plan_payload_digest
        FROM telegram_alert_target_plans WHERE plan_ordinal < 20 ORDER BY plan_ordinal`).all()).toEqual(retainedV3);
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM telegram_pending_alerts
        WHERE dedupe_key LIKE '%:v3:%'`).get()).toEqual({ count: 40 });
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM telegram_pending_alerts
        WHERE dedupe_key LIKE '%:v4:%'`).get()).toEqual({ count: 10 });
    }
    if (withdrawn) {
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts WHERE chat_id = '030'").get())
        .toEqual({ count: 0 });
    }
  });

  it("resumes an authoritative manifest without reconstructing handled direct/global items", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:handled-manifest-resume";
    insertSource(sqlite, sourceEventId);
    for (const chatId of ["direct", "global", "preset"]) insertSubscriber(sqlite, chatId);
    await openDeliveryForRoutes(db, sourceEventId, new Map(
      ["direct", "global", "preset"].map((chatId) => [chatId, [routed(chatId, sourceEventId, 1)]]),
    ));
    sqlite.exec(`UPDATE telegram_alert_job_targets
      SET status = 'sent', effect_state = 'complete', final_delivery_state = 'accepted'
      WHERE chat_id = 'direct';
      UPDATE telegram_alert_job_targets
      SET status = 'queued', effect_state = 'execution_unknown', final_delivery_state = 'execution_unknown'
      WHERE chat_id = 'global'`);
    const retainedTargets = sqlite.prepare(`SELECT * FROM telegram_alert_job_targets
      WHERE chat_id IN ('direct', 'global') ORDER BY chat_id`).all();
    const retainedItems = sqlite.prepare(`SELECT * FROM telegram_alert_target_plan_items
      ORDER BY plan_key, item_key`).all();
    const resumed = await runTelegramTargetPlanCoordinator({
      db, sourceEventId, nowSec: NOW + 121,
      callbacks: {
        resolveInitialEligibility: async () => { throw new Error("must not recapture handled recipients"); },
        planSubscribers: async () => { throw new Error("must not reconstruct handled source items"); },
      },
    });
    expect(resumed).toMatchObject({ state: "delivery_open", enqueued: 1 });
    expect(sqlite.prepare("SELECT chat_id FROM telegram_pending_alerts").all()).toEqual([{ chat_id: "preset" }]);
    expect(sqlite.prepare(`SELECT * FROM telegram_alert_job_targets
      WHERE chat_id IN ('direct', 'global') ORDER BY chat_id`).all()).toEqual(retainedTargets);
    expect(sqlite.prepare(`SELECT * FROM telegram_alert_target_plan_items
      ORDER BY plan_key, item_key`).all()).toEqual(retainedItems);
    expect(await enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW + 122))
      .toMatchObject({ enqueued: 0, remaining: 0 });
  });

  it.each([
    ["missing plan", "DELETE FROM telegram_alert_target_plans WHERE chat_id = '2'"],
    ["missing target", "DELETE FROM telegram_alert_job_targets WHERE chat_id = '2'"],
    ["missing item", `DELETE FROM telegram_alert_target_plan_items
      WHERE plan_key IN (SELECT plan_key FROM telegram_alert_target_plans WHERE chat_id = '2')`],
    ["replaced item", `UPDATE telegram_alert_target_plan_items SET item_key = 'unrelated'
      WHERE plan_key IN (SELECT plan_key FROM telegram_alert_target_plans WHERE chat_id = '2')`],
    ["replaced target", "UPDATE telegram_alert_job_targets SET message_html = 'unrelated' WHERE chat_id = '2'"],
    ["invalid digest", "UPDATE telegram_alert_target_plans SET plan_payload_digest = printf('%064d', 0) WHERE chat_id = '2'"],
    ["erased interior", `DELETE FROM telegram_alert_target_plan_items
       WHERE plan_key IN (SELECT plan_key FROM telegram_alert_target_plans WHERE chat_id = '2');
       DELETE FROM telegram_alert_job_targets WHERE chat_id = '2';
       DELETE FROM telegram_alert_target_plans WHERE chat_id = '2';
       DELETE FROM telegram_alert_planning_subscribers WHERE chat_id = '2'`],
    ["migrated interior", `UPDATE telegram_alert_planning_subscribers SET chat_id = '4' WHERE chat_id = '2';
       UPDATE telegram_alert_target_plans SET chat_id = '4' WHERE chat_id = '2';
       UPDATE telegram_alert_job_targets SET chat_id = '4' WHERE chat_id = '2'`],
  ])("holds an incomplete retained manifest after %s", async (_reason, corrupt) => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:retained-proof";
    insertSource(sqlite, sourceEventId);
    for (const chatId of ["1", "2", "3"]) insertSubscriber(sqlite, chatId);
    await openDeliveryForRoutes(db, sourceEventId, new Map(
      ["1", "2", "3"].map((chatId) => [chatId, [routed(chatId, sourceEventId, 1)]]),
    ));
    sqlite.exec(`UPDATE telegram_alert_target_plan_pages SET status = 'materializing', completed_at = NULL;
      UPDATE telegram_alert_source_events SET target_plan_state = 'materializing',
        planning_cursor_chat_id = NULL, target_delivery_opened_at = NULL; ${corrupt}`);
    const claim = await claimTelegramTargetPlanning(db, sourceEventId, NOW + 1, "test-owner");
    expect(claim).not.toBeNull();
    await expect(reconcileIncompleteTelegramTargetPlanPage(db, claim!, NOW + 1)).rejects.toThrow();
    expect(sqlite.prepare("SELECT status FROM telegram_alert_target_plan_pages").get())
      .toEqual({ status: "materializing" });
    expect(sqlite.prepare(`SELECT target_plan_state, target_delivery_opened_at,
      planning_cursor_chat_id FROM telegram_alert_source_events`).get())
      .toEqual({ target_plan_state: "degraded", target_delivery_opened_at: null, planning_cursor_chat_id: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("recovers an intact count-mismatch-degraded manifest without replaying ineligible members", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:legacy-count-mismatch";
    insertSource(sqlite, sourceEventId);
    for (const chatId of ["1", "2", "3"]) insertSubscriber(sqlite, chatId);
    const claim = await captureClaim(db, sourceEventId, new Map([["1", true], ["2", true], ["3", true]]));
    const subscribers = await loadTelegramPlanningSubscriberPage(db, claim);
    await materializeTelegramTargetPlanPage(db, claim, 0, subscribers.map((subscriber) => ({
      subscriber, currentPreferenceGeneration: 1, currentEligible: subscriber.chatId !== "3",
      routed: subscriber.chatId === "3" ? [] : [routed(subscriber.chatId, sourceEventId, 1)],
    })), NOW);
    sqlite.exec(`UPDATE telegram_alert_target_plan_pages SET status = 'materializing',
      expected_plan_count = 3, expected_target_count = 3, completed_at = NULL;
      UPDATE telegram_alert_source_events SET target_plan_state = 'degraded',
        last_error_class = 'target_page_count_mismatch', planning_cursor_chat_id = NULL;`);
    const result = await runTelegramTargetPlanCoordinator({
      db, sourceEventId, nowSec: NOW + 121,
      callbacks: {
        resolveInitialEligibility: async () => { throw new Error("must not recapture"); },
        planSubscribers: async () => { throw new Error("must not rerender finalized decisions"); },
      },
    });
    expect(result).toMatchObject({ state: "delivery_open", enqueued: 2 });
    expect(sqlite.prepare("SELECT chat_id FROM telegram_pending_alerts ORDER BY chat_id").all())
      .toEqual([{ chat_id: "1" }, { chat_id: "2" }]);
    expect(sqlite.prepare(`SELECT expected_plan_count, materialized_plan_count,
      expected_target_count, materialized_target_count FROM telegram_alert_target_plan_pages`).get())
      .toEqual({ expected_plan_count: 2, materialized_plan_count: 2,
        expected_target_count: 2, materialized_target_count: 2 });
  });

  it("seals an all-ineligible decision page with zero targets", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:zero-targets";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    const claim = await captureClaim(db, sourceEventId, new Map([["42", true]]));
    const subscribers = await loadTelegramPlanningSubscriberPage(db, claim);
    await materializeTelegramTargetPlanPage(db, claim, 0, subscribers.map((subscriber) => ({
      subscriber, currentPreferenceGeneration: 2, currentEligible: false, routed: [],
    })), NOW);
    await finalizeTelegramTargetPlanning(db, claim, NOW);
    expect(await openTelegramTargetPlanDelivery(db, claim, NOW)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_target_plans").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
    expect(sqlite.prepare(`SELECT status, expected_plan_count, expected_target_count
      FROM telegram_alert_target_plan_pages`).get())
      .toEqual({ status: "complete", expected_plan_count: 0, expected_target_count: 0 });
  });

  it("rejects multiple consolidated routes for one captured chat", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:multiple-routes";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    const claim = await captureClaim(db, sourceEventId, new Map([["42", true]]));
    const [subscriber] = await loadTelegramPlanningSubscriberPage(db, claim);
    await expect(materializeTelegramTargetPlanPage(db, claim, 0, [{
      subscriber, currentPreferenceGeneration: 1, currentEligible: true,
      routed: [routed("42", sourceEventId, 1), routed("42", sourceEventId, 1, "-second")],
    }], NOW)).rejects.toThrow("one consolidated target plan");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_target_plans").get()).toEqual({ count: 0 });
  });

  it("does not seal or advance the cursor when finalized decisions change during admission", async () => {
    const { sqlite, db: baseDb } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:seal-ledger-race";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    const claim = await captureClaim(baseDb, sourceEventId, new Map([["42", true]]));
    const [subscriber] = await loadTelegramPlanningSubscriberPage(baseDb, claim);
    let batches = 0;
    const racingDb = {
      ...baseDb,
      batch: async (statements: D1PreparedStatement[]) => {
        batches += 1;
        if (batches === 2) sqlite.exec(`UPDATE telegram_alert_planning_subscribers
          SET planning_outcome = 'pending', planned_at = NULL`);
        return baseDb.batch(statements);
      },
    } as D1Database;
    await expect(materializeTelegramTargetPlanPage(racingDb, claim, 0, [{
      subscriber, currentPreferenceGeneration: 1, currentEligible: true,
      routed: [routed("42", sourceEventId, 1)],
    }], NOW)).rejects.toThrow("resume CAS was not confirmed");
    expect(sqlite.prepare("SELECT status FROM telegram_alert_target_plan_pages").get())
      .toEqual({ status: "materializing" });
    expect(sqlite.prepare(`SELECT planning_cursor_chat_id, target_delivery_opened_at
      FROM telegram_alert_source_events`).get())
      .toEqual({ planning_cursor_chat_id: null, target_delivery_opened_at: null });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
  });

  it("never restores a subscriber's erased plan evidence from a stale decision", async () => {
    const { sqlite, db: baseDb } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:erased-before-unit";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    const claim = await captureClaim(baseDb, sourceEventId, new Map([["42", true]]));
    const [subscriber] = await loadTelegramPlanningSubscriberPage(baseDb, claim);
    const erasingDb = {
      ...baseDb,
      batch: async (statements: D1PreparedStatement[]) => {
        sqlite.exec(`DELETE FROM telegram_alert_planning_subscribers WHERE chat_id = '42';
          DELETE FROM telegram_subscribers WHERE chat_id = '42'`);
        return baseDb.batch(statements);
      },
    } as D1Database;
    await expect(materializeTelegramTargetPlanPage(erasingDb, claim, 0, [{
      subscriber, currentPreferenceGeneration: 1, currentEligible: true,
      routed: [routed("42", sourceEventId, 1)],
    }], NOW)).rejects.toThrow();
    for (const table of ["telegram_alert_planning_subscribers", "telegram_alert_target_plans",
      "telegram_alert_job_targets", "telegram_alert_target_plan_items", "telegram_pending_alerts"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(sqlite.prepare("SELECT target_delivery_opened_at FROM telegram_alert_source_events").get())
      .toEqual({ target_delivery_opened_at: null });
  });

  it("holds an old zero-target window whose original membership has no intact witness", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:unproven-zero";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    const claim = await captureClaim(db, sourceEventId, new Map([["42", false]]));
    const [subscriber] = await loadTelegramPlanningSubscriberPage(db, claim);
    await materializeTelegramTargetPlanPage(db, claim, 0, [{
      subscriber, currentPreferenceGeneration: 1, currentEligible: false, routed: [],
    }], NOW);
    sqlite.exec(`UPDATE telegram_alert_target_plan_pages SET status = 'materializing', completed_at = NULL;
      UPDATE telegram_alert_source_events SET planning_cursor_chat_id = NULL;`);
    await expect(reconcileIncompleteTelegramTargetPlanPage(db, claim, NOW + 1))
      .rejects.toThrow("target_page_membership_unproven");
    expect(sqlite.prepare("SELECT target_plan_state, last_error_class FROM telegram_alert_source_events").get())
      .toEqual({ target_plan_state: "degraded", last_error_class: "target_page_membership_unproven" });
  });

  it.each(["before finalization", "before delivery-open"] as const)(
    "does not redefine sealed totals after privacy erasure %s", async (boundary) => {
      const { sqlite, db } = setupLatestSchema();
      const sourceEventId = "telegram-source:test:v1:erase-after-seal";
      insertSource(sqlite, sourceEventId);
      for (const chatId of ["1", "2", "3"]) insertSubscriber(sqlite, chatId);
      const claim = await captureClaim(db, sourceEventId, new Map([["1", true], ["2", true], ["3", true]]));
      const subscribers = await loadTelegramPlanningSubscriberPage(db, claim);
      await materializeTelegramTargetPlanPage(db, claim, 0, subscribers.map((subscriber) => ({
        subscriber, currentPreferenceGeneration: 1, currentEligible: true,
        routed: [routed(subscriber.chatId, sourceEventId, 1)],
      })), NOW);
      if (boundary === "before delivery-open") await finalizeTelegramTargetPlanning(db, claim, NOW);
      sqlite.exec(`DELETE FROM telegram_alert_target_plan_items
        WHERE plan_key IN (SELECT plan_key FROM telegram_alert_target_plans WHERE chat_id = '2');
        DELETE FROM telegram_alert_job_targets WHERE chat_id = '2';
        DELETE FROM telegram_alert_target_plans WHERE chat_id = '2';
        DELETE FROM telegram_alert_planning_subscribers WHERE chat_id = '2';
        DELETE FROM telegram_subscribers WHERE chat_id = '2'`);
      if (boundary === "before finalization") {
        await expect(finalizeTelegramTargetPlanning(db, claim, NOW + 1))
          .rejects.toThrow("before exact reconciliation");
      } else {
        expect(await openTelegramTargetPlanDelivery(db, claim, NOW + 1)).toBe(false);
      }
      expect(sqlite.prepare(`SELECT expected_plan_count, expected_target_count
        FROM telegram_alert_target_plan_pages`).get())
        .toEqual({ expected_plan_count: 3, expected_target_count: 3 });
      expect(sqlite.prepare("SELECT target_delivery_opened_at FROM telegram_alert_source_events").get())
        .toEqual({ target_delivery_opened_at: null });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
    },
  );

  it.each(["sent", "expired"] as const)("does not project source B status or cancellation onto historical source A %s targets", async (priorStatus) => {
    const { sqlite, db } = setupLatestSchema();
    insertSubscriber(sqlite, "42");
    for (const sourceEventId of ["telegram-source:test:v1:recurrence-a", "telegram-source:test:v1:recurrence-b"]) {
      insertSource(sqlite, sourceEventId);
      await openDeliveryForRoutes(db, sourceEventId, new Map([["42", [routed("42", sourceEventId, 1)]]]));
    }
    const sourceA = "telegram-source:test:v1:recurrence-a";
    const sourceB = "telegram-source:test:v1:recurrence-b";
    sqlite.prepare("UPDATE telegram_alert_job_targets SET status = ? WHERE source_event_id = ?").run(priorStatus, sourceA);
    const prior = sqlite.prepare("SELECT * FROM telegram_alert_job_targets WHERE source_event_id = ?").get(sourceA);
    const current = sqlite.prepare("SELECT pending_dedupe_key FROM telegram_alert_job_targets WHERE source_event_id = ?").get(sourceB) as { pending_dedupe_key: string };
    await recordTelegramAlertTargetStatuses(db, [{
      targetKey: current.pending_dedupe_key, sourceEventId: sourceB, status: "queued", at: NOW + 1, errorClass: "server_error",
    }]);
    expect(sqlite.prepare("SELECT * FROM telegram_alert_job_targets WHERE source_event_id = ?").get(sourceA)).toEqual(prior);
    expect(sqlite.prepare("SELECT status, error_class FROM telegram_alert_job_targets WHERE source_event_id = ?").get(sourceB)).toEqual({ status: "queued", error_class: "server_error" });
    await recordTelegramAlertTargetCancellations(db, [{
      targetKey: current.pending_dedupe_key, sourceEventId: sourceB, at: NOW + 2, reason: "scope_disabled",
    }]);
    expect(sqlite.prepare("SELECT * FROM telegram_alert_job_targets WHERE source_event_id = ?").get(sourceA)).toEqual(prior);
    expect(sqlite.prepare("SELECT status, cancelled_at, cancellation_reason FROM telegram_alert_job_targets WHERE source_event_id = ?").get(sourceB)).toEqual({
      status: "failed", cancelled_at: NOW + 2, cancellation_reason: "scope_disabled",
    });
  });

  it.each([
    ["sent", "duplicate_prior_delivery"],
    ["execution_unknown", "duplicate_prior_execution_unknown"],
  ] as const)(
    "suppresses a prior-source %s dedupe collision and continues the handoff page",
    async (deliveryState, cancellationReason) => {
      const { sqlite, db } = setupLatestSchema();
      const priorSourceEventId = `telegram-source:test:v1:prior-${deliveryState}`;
      const currentSourceEventId = `telegram-source:test:v1:current-${deliveryState}`;
      insertSubscriber(sqlite, "42");
      insertSubscriber(sqlite, "43");

      insertSource(sqlite, priorSourceEventId);
      await openDeliveryForRoutes(
        db,
        priorSourceEventId,
        new Map([
          ["42", [routed("42", priorSourceEventId, 1)]],
          ["43", []],
        ]),
      );
      await enqueueTelegramAuthoritativeTargets(db, priorSourceEventId, 1, NOW);
      sqlite
        .prepare(
          `UPDATE telegram_pending_alerts
              SET delivery_state = ?, delivery_completed_at = ?, last_error_class = ?
            WHERE source_event_id = ?`,
        )
        .run(
          deliveryState,
          NOW + 1,
          deliveryState === "execution_unknown" ? "timeout" : null,
          priorSourceEventId,
        );
      await reconcileTelegramJobTargetFinalDeliveryFromPending(db, NOW + 1);

      insertSource(sqlite, currentSourceEventId);
      await openDeliveryForRoutes(
        db,
        currentSourceEventId,
        new Map([
          ["42", [routed("42", currentSourceEventId, 1)]],
          ["43", [routed("43", currentSourceEventId, 1, "-unique")]],
        ]),
      );
      const handoff = await enqueueTelegramAuthoritativeTargets(db, currentSourceEventId, 1, NOW + 2);

      expect(handoff).toMatchObject({ enqueued: 1, processed: 2, remaining: 0 });
      expect(
        sqlite
          .prepare(
            `SELECT chat_id, status, final_delivery_state, cancellation_reason
               FROM telegram_alert_job_targets
              WHERE source_event_id = ? ORDER BY chat_id`,
          )
          .all(currentSourceEventId),
      ).toEqual([
        {
          chat_id: "42",
          status: "expired",
          final_delivery_state: "cancelled",
          cancellation_reason: cancellationReason,
        },
        {
          chat_id: "43",
          status: "queued",
          final_delivery_state: null,
          cancellation_reason: null,
        },
      ]);
      expect(
        sqlite
          .prepare(
            `SELECT source_event_id, delivery_state
               FROM telegram_pending_alerts
              WHERE chat_id = '42'`,
          )
          .all(),
      ).toEqual([{ source_event_id: priorSourceEventId, delivery_state: deliveryState }]);
      expect(
        sqlite
          .prepare("SELECT target_plan_state, last_error_class FROM telegram_alert_source_events WHERE source_event_id = ?")
          .get(currentSourceEventId),
      ).toEqual({ target_plan_state: "delivery_open", last_error_class: null });
    },
  );

  it("suppresses exact terminal content when only disable_notification changed and continues the handoff page", async () => {
    const { sqlite, db } = setupLatestSchema();
    const priorSourceEventId = "telegram-source:test:v1:prior-silent";
    const currentSourceEventId = "telegram-source:test:v1:current-audible";
    insertSubscriber(sqlite, "42");
    insertSubscriber(sqlite, "43");

    insertSource(sqlite, priorSourceEventId);
    await openDeliveryForRoutes(
      db,
      priorSourceEventId,
      new Map([
        ["42", [{ ...routed("42", priorSourceEventId, 1), disableNotification: true }]],
        ["43", []],
      ]),
    );
    await enqueueTelegramAuthoritativeTargets(db, priorSourceEventId, 1, NOW);
    sqlite
      .prepare(
        `UPDATE telegram_pending_alerts
            SET delivery_state = 'sent', delivery_completed_at = ?
          WHERE source_event_id = ?`,
      )
      .run(NOW + 1, priorSourceEventId);
    await reconcileTelegramJobTargetFinalDeliveryFromPending(db, NOW + 1);

    insertSource(sqlite, currentSourceEventId);
    await openDeliveryForRoutes(
      db,
      currentSourceEventId,
      new Map([
        ["42", [routed("42", currentSourceEventId, 1)]],
        ["43", [routed("43", currentSourceEventId, 1, "-unique")]],
      ]),
    );
    expect(
      sqlite
        .prepare(
          `SELECT pending.disable_notification AS prior_disable_notification,
                  target.disable_notification AS current_disable_notification
             FROM telegram_pending_alerts pending
             JOIN telegram_alert_job_targets target ON target.chat_id = pending.chat_id
            WHERE pending.source_event_id = ? AND target.source_event_id = ?`,
        )
        .get(priorSourceEventId, currentSourceEventId),
    ).toEqual({ prior_disable_notification: 1, current_disable_notification: 0 });

    const handoff = await enqueueTelegramAuthoritativeTargets(db, currentSourceEventId, 1, NOW + 2);

    expect(handoff).toMatchObject({ enqueued: 1, processed: 2, remaining: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT chat_id, status, final_delivery_state, cancellation_reason
             FROM telegram_alert_job_targets
            WHERE source_event_id = ? ORDER BY chat_id`,
        )
        .all(currentSourceEventId),
    ).toEqual([
      {
        chat_id: "42",
        status: "expired",
        final_delivery_state: "cancelled",
        cancellation_reason: "duplicate_prior_delivery",
      },
      {
        chat_id: "43",
        status: "queued",
        final_delivery_state: null,
        cancellation_reason: null,
      },
    ]);
    expect(
      sqlite
        .prepare("SELECT target_plan_state, last_error_class FROM telegram_alert_source_events WHERE source_event_id = ?")
        .get(currentSourceEventId),
    ).toEqual({ target_plan_state: "delivery_open", last_error_class: null });
  });

  it("does not suppress a different payload that only collides on the persisted dedupe hash", async () => {
    const { sqlite, db } = setupLatestSchema();
    const priorSourceEventId = "telegram-source:test:v1:prior-hash-collision";
    const currentSourceEventId = "telegram-source:test:v1:current-hash-collision";
    insertSubscriber(sqlite, "42");

    insertSource(sqlite, priorSourceEventId);
    await openDeliveryForRoutes(
      db,
      priorSourceEventId,
      new Map([["42", [routed("42", priorSourceEventId, 1)]]]),
    );
    await enqueueTelegramAuthoritativeTargets(db, priorSourceEventId, 1, NOW);
    sqlite
      .prepare(
        `UPDATE telegram_pending_alerts
            SET delivery_state = 'sent', delivery_completed_at = ?
          WHERE source_event_id = ?`,
      )
      .run(NOW + 1, priorSourceEventId);

    insertSource(sqlite, currentSourceEventId);
    await openDeliveryForRoutes(
      db,
      currentSourceEventId,
      new Map([["42", [routed("42", currentSourceEventId, 1, "-different")]]]),
    );
    const prior = sqlite
      .prepare("SELECT dedupe_key FROM telegram_pending_alerts WHERE source_event_id = ?")
      .get(priorSourceEventId) as { dedupe_key: string };
    sqlite
      .prepare(
        `UPDATE telegram_alert_job_targets
            SET pending_dedupe_key = ?
          WHERE source_event_id = ?`,
      )
      .run(prior.dedupe_key, currentSourceEventId);

    await expect(
      enqueueTelegramAuthoritativeTargets(db, currentSourceEventId, 1, NOW + 2),
    ).rejects.toThrow("pending handoff was not confirmed");
    expect(
      sqlite
        .prepare(
          `SELECT target_plan_state, last_error_class
             FROM telegram_alert_source_events WHERE source_event_id = ?`,
        )
        .get(currentSourceEventId),
    ).toEqual({ target_plan_state: "degraded", last_error_class: "pending_identity_collision" });
    expect(
      sqlite
        .prepare(
          `SELECT status, final_delivery_state, cancellation_reason
             FROM telegram_alert_job_targets WHERE source_event_id = ?`,
        )
        .get(currentSourceEventId),
    ).toEqual({ status: "planned", final_delivery_state: null, cancellation_reason: null });
  });

  it("keeps degraded hash-only identity collisions closed across coordinator runs", async () => {
    const { sqlite, db } = setupLatestSchema();
    const priorSourceEventId = "telegram-source:test:v1:prior-hash-reopen";
    const currentSourceEventId = "telegram-source:test:v1:current-hash-reopen";
    insertSubscriber(sqlite, "42");

    insertSource(sqlite, priorSourceEventId);
    await openDeliveryForRoutes(
      db,
      priorSourceEventId,
      new Map([["42", [routed("42", priorSourceEventId, 1)]]]),
    );
    await enqueueTelegramAuthoritativeTargets(db, priorSourceEventId, 1, NOW);
    sqlite
      .prepare(
        `UPDATE telegram_pending_alerts
            SET delivery_state = 'sent', delivery_completed_at = ?
          WHERE source_event_id = ?`,
      )
      .run(NOW + 1, priorSourceEventId);

    insertSource(sqlite, currentSourceEventId);
    await openDeliveryForRoutes(
      db,
      currentSourceEventId,
      new Map([["42", [routed("42", currentSourceEventId, 1, "-different")]]]),
    );
    const prior = sqlite
      .prepare("SELECT dedupe_key FROM telegram_pending_alerts WHERE source_event_id = ?")
      .get(priorSourceEventId) as { dedupe_key: string };
    sqlite
      .prepare(
        `UPDATE telegram_alert_job_targets
            SET pending_dedupe_key = ?
          WHERE source_event_id = ?`,
      )
      .run(prior.dedupe_key, currentSourceEventId);

    await expect(
      enqueueTelegramAuthoritativeTargets(db, currentSourceEventId, 1, NOW + 2),
    ).rejects.toThrow("pending handoff was not confirmed");

    const result = await runTelegramTargetPlanCoordinator({
      db,
      sourceEventId: currentSourceEventId,
      nowSec: NOW + 3,
      maxSteps: 2,
      deliveryHandoffLimit: 1,
      callbacks: {
        resolveInitialEligibility: async () => {
          throw new Error("hash-only collision recovery must not recapture subscribers");
        },
        planSubscribers: async () => {
          throw new Error("hash-only collision recovery must not rematerialize targets");
        },
      },
    });

    expect(result).toMatchObject({
      state: "degraded",
      steps: 1,
      enqueued: 0,
      remainingTargets: 0,
    });
    expect(
      sqlite
        .prepare(
          `SELECT target_plan_state, last_error_class, last_attempt_at
             FROM telegram_alert_source_events WHERE source_event_id = ?`,
        )
        .get(currentSourceEventId),
    ).toEqual({
      target_plan_state: "degraded",
      last_error_class: "pending_identity_collision",
      last_attempt_at: NOW + 2,
    });
    expect(
      sqlite
        .prepare(
          `SELECT status, final_delivery_state, cancellation_reason
             FROM telegram_alert_job_targets WHERE source_event_id = ?`,
        )
        .get(currentSourceEventId),
    ).toEqual({ status: "planned", final_delivery_state: null, cancellation_reason: null });
  });

  it("re-enters handoff for an already-degraded terminal identity collision", async () => {
    const { sqlite, db } = setupLatestSchema();
    const priorSourceEventId = "telegram-source:test:v1:prior-degraded-recovery";
    const currentSourceEventId = "telegram-source:test:v1:current-degraded-recovery";
    insertSubscriber(sqlite, "42");
    insertSubscriber(sqlite, "43");

    insertSource(sqlite, priorSourceEventId);
    await openDeliveryForRoutes(
      db,
      priorSourceEventId,
      new Map([
        ["42", [routed("42", priorSourceEventId, 1)]],
        ["43", []],
      ]),
    );
    await enqueueTelegramAuthoritativeTargets(db, priorSourceEventId, 1, NOW);
    sqlite
      .prepare(
        `UPDATE telegram_pending_alerts
            SET delivery_state = 'sent', delivery_completed_at = ?
          WHERE source_event_id = ?`,
      )
      .run(NOW + 1, priorSourceEventId);
    await reconcileTelegramJobTargetFinalDeliveryFromPending(db, NOW + 1);

    insertSource(sqlite, currentSourceEventId);
    await openDeliveryForRoutes(
      db,
      currentSourceEventId,
      new Map([
        ["42", [routed("42", currentSourceEventId, 1)]],
        ["43", [routed("43", currentSourceEventId, 1, "-unique")]],
      ]),
    );
    sqlite
      .prepare(
        `UPDATE telegram_alert_source_events
            SET target_plan_state = 'degraded', last_error_class = 'pending_identity_collision'
          WHERE source_event_id = ?`,
      )
      .run(currentSourceEventId);

    const result = await runTelegramTargetPlanCoordinator({
      db,
      sourceEventId: currentSourceEventId,
      nowSec: NOW + 2,
      maxSteps: 2,
      deliveryHandoffLimit: 2,
      callbacks: {
        resolveInitialEligibility: async () => {
          throw new Error("degraded delivery recovery must not recapture subscribers");
        },
        planSubscribers: async () => {
          throw new Error("degraded delivery recovery must not rematerialize targets");
        },
      },
    });

    expect(result).toMatchObject({
      state: "delivery_open",
      steps: 2,
      enqueued: 1,
      remainingTargets: 0,
    });
    expect(
      sqlite
        .prepare(
          `SELECT chat_id, status, final_delivery_state, cancellation_reason
             FROM telegram_alert_job_targets
            WHERE source_event_id = ? ORDER BY chat_id`,
        )
        .all(currentSourceEventId),
    ).toEqual([
      {
        chat_id: "42",
        status: "expired",
        final_delivery_state: "cancelled",
        cancellation_reason: "duplicate_prior_delivery",
      },
      {
        chat_id: "43",
        status: "queued",
        final_delivery_state: null,
        cancellation_reason: null,
      },
    ]);
  });

  it("preserves target-plan degradation evidence across preset resolution", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:preserve-target-plan-error";
    insertSource(sqlite, sourceEventId, { state: "degraded", generation: 1 });
    sqlite
      .prepare(
        `UPDATE telegram_alert_source_events
            SET last_error_class = 'payload_digest_mismatch'
          WHERE source_event_id = ?`,
      )
      .run(sourceEventId);
    const source = await loadTelegramAlertSourceEvent(db, sourceEventId);
    if (!source) throw new Error("source missing");

    await resolveTelegramAlertSourcePresetPages(db, source, NOW + 1, { includeSubscriberMaps: false });

    expect(
      sqlite
        .prepare("SELECT last_error_class FROM telegram_alert_source_events WHERE source_event_id = ?")
        .get(sourceEventId),
    ).toEqual({ last_error_class: "payload_digest_mismatch" });
  });

  it("does not persist eligibility observed at a different generation", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:interleave";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42", 1);
    const claim = (await claimTelegramTargetPlanning(db, sourceEventId, NOW, "owner"))!;

    await expect(
      captureTelegramPlanningSubscriberPage(db, claim, NOW, async () => {
        sqlite.prepare("UPDATE telegram_subscribers SET preference_generation = 2 WHERE chat_id = '42'").run();
        return new Map([["42", { eligible: true, observedPreferenceGeneration: 2 }]]);
      }),
    ).rejects.toThrow("before capture-time eligibility");
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_alert_planning_subscribers").get()).toEqual({
      count: 0,
    });
    expect(
      sqlite
        .prepare("SELECT subscriber_cursor_chat_id FROM telegram_alert_source_events WHERE source_event_id = ?")
        .get(sourceEventId),
    ).toEqual({ subscriber_cursor_chat_id: null });

    await captureTelegramPlanningSubscriberPage(
      db,
      claim,
      NOW,
      async (subscribers) =>
        new Map([
          [
            "42",
            {
              eligible: true,
              observedPreferenceGeneration: subscribers[0].preferenceGeneration,
            },
          ],
        ]),
    );
    expect(
      sqlite.prepare("SELECT preference_generation, initially_eligible FROM telegram_alert_planning_subscribers").get(),
    ).toEqual({ preference_generation: 2, initially_eligible: 1 });
  });

  it("freezes subscriber capture at event detection and excludes later signups", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:detection-horizon";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "1", 1, NOW - 1);
    insertSubscriber(sqlite, "2", 1, NOW + 1);

    const claim = await claimTelegramTargetPlanning(db, sourceEventId, NOW + 100, "owner");
    expect(claim).toMatchObject({
      horizonAt: NOW,
      highWaterChatId: "1",
    });
    const resolvedChats: string[] = [];
    await captureTelegramPlanningSubscriberPage(db, claim!, NOW + 100, async (subscribers) => {
      resolvedChats.push(...subscribers.map((subscriber) => subscriber.chatId));
      return new Map(
        subscribers.map((subscriber) => [
          subscriber.chatId,
          {
            eligible: true,
            observedPreferenceGeneration: subscriber.preferenceGeneration,
          },
        ]),
      );
    });

    expect(resolvedChats).toEqual(["1"]);
    expect(sqlite.prepare("SELECT chat_id FROM telegram_alert_planning_subscribers ORDER BY chat_id").all()).toEqual([
      { chat_id: "1" },
    ]);
    expect(
      sqlite
        .prepare(
          `SELECT subscriber_horizon_at, subscriber_high_water_chat_id
         FROM telegram_alert_source_events WHERE source_event_id = ?`,
        )
        .get(sourceEventId),
    ).toEqual({
      subscriber_horizon_at: NOW,
      subscriber_high_water_chat_id: "1",
    });
  });

  it("reports max-step planning as deferred while holding the source baseline", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:bounded-coordinator";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    let planned = false;

    const result = await runTelegramTargetPlanCoordinator({
      db,
      sourceEventId,
      nowSec: NOW,
      maxSteps: 1,
      callbacks: {
        resolveInitialEligibility: async (subscribers) =>
          new Map(
            subscribers.map((subscriber) => [
              subscriber.chatId,
              {
                eligible: true,
                observedPreferenceGeneration: subscriber.preferenceGeneration,
              },
            ]),
          ),
        planSubscribers: async () => {
          planned = true;
          return [];
        },
      },
    });

    expect(result).toMatchObject({ state: "planning", steps: 1, enqueued: 0, remainingTargets: 0 });
    expect(planned).toBe(false);
    expect(hasDeferredTelegramAuthoritativeWork(true, result)).toBe(true);
    expect(
      hasDeferredTelegramAuthoritativeWork(true, {
        state: "delivery_open",
        remainingTargets: 0,
        expiryComplete: false,
      }),
    ).toBe(false);
    expect(
      sqlite
        .prepare(
          `SELECT status, baseline_committed_at, target_plan_state,
              target_plan_owner, target_plan_claim_expires_at
         FROM telegram_alert_source_events WHERE source_event_id = ?`,
        )
        .get(sourceEventId),
    ).toEqual({
      status: "planned",
      baseline_committed_at: null,
      target_plan_state: "planning",
      target_plan_owner: null,
      target_plan_claim_expires_at: null,
    });

    const resumed = await runTelegramTargetPlanCoordinator({
      db,
      sourceEventId,
      nowSec: NOW,
      maxSteps: 1,
      callbacks: {
        resolveInitialEligibility: async () => {
          throw new Error("completed capture must not be repeated");
        },
        planSubscribers: async (subscribers) => {
          planned = true;
          return subscribers.map((subscriber) => ({
            subscriber,
            currentPreferenceGeneration: 1,
            currentEligible: true,
            routed: [routed(subscriber.chatId, sourceEventId, 1)],
          }));
        },
      },
    });
    expect(resumed).toMatchObject({ state: "planning", steps: 1 });
    expect(planned).toBe(true);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM telegram_alert_job_targets WHERE source_event_id = ?")
        .get(sourceEventId),
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT target_plan_owner, target_plan_claim_expires_at
         FROM telegram_alert_source_events WHERE source_event_id = ?`,
        )
        .get(sourceEventId),
    ).toEqual({
      target_plan_owner: null,
      target_plan_claim_expires_at: null,
    });
  });

  it("plans unrelated churn, records unsubscribe, and excludes newly eligible history", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:churn";
    insertSource(sqlite, sourceEventId);
    for (const chatId of ["1", "2", "3"]) insertSubscriber(sqlite, chatId, 1);
    const claim = await captureClaim(
      db,
      sourceEventId,
      new Map([
        ["1", true],
        ["2", true],
        ["3", false],
      ]),
    );
    sqlite.exec("UPDATE telegram_subscribers SET preference_generation = 2");
    const subscribers = await loadTelegramPlanningSubscriberPage(db, claim);
    const byChat = new Map(subscribers.map((subscriber) => [subscriber.chatId, subscriber]));
    const decisions: TelegramPlanningDecision[] = [
      {
        subscriber: byChat.get("1")!,
        currentPreferenceGeneration: 2,
        currentEligible: true,
        routed: [routed("1", sourceEventId, 2, "-one")],
      },
      {
        subscriber: byChat.get("2")!,
        currentPreferenceGeneration: 2,
        currentEligible: false,
        routed: [],
      },
      {
        subscriber: byChat.get("3")!,
        currentPreferenceGeneration: 2,
        currentEligible: true,
        routed: [routed("3", sourceEventId, 2, "-three")],
      },
    ];
    await materializeTelegramTargetPlanPage(db, claim, 0, decisions, NOW);

    expect(
      sqlite
        .prepare("SELECT chat_id, planning_outcome FROM telegram_alert_planning_subscribers ORDER BY chat_id")
        .all(),
    ).toEqual([
      { chat_id: "1", planning_outcome: "target_planned" },
      { chat_id: "2", planning_outcome: "preference_changed_ineligible" },
      { chat_id: "3", planning_outcome: "eligible_after_event" },
    ]);
    expect(sqlite.prepare("SELECT chat_id, preference_generation FROM telegram_alert_job_targets").all()).toEqual([
      { chat_id: "1", preference_generation: 2 },
    ]);
  });

  it("resumes the crash after all decisions and fences a failed completion CAS", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:page-resume";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    const claim = await captureClaim(db, sourceEventId, new Map([["42", true]]));
    const [subscriber] = await loadTelegramPlanningSubscriberPage(db, claim);
    await materializeTelegramTargetPlanPage(
      db,
      claim,
      0,
      [
        {
          subscriber,
          currentPreferenceGeneration: 1,
          currentEligible: true,
          routed: [routed("42", sourceEventId, 1)],
        },
      ],
      NOW,
    );

    sqlite.exec(`UPDATE telegram_alert_target_plan_pages SET status = 'materializing', completed_at = NULL;
      UPDATE telegram_alert_source_events SET planning_cursor_chat_id = NULL;`);
    await expect(reconcileIncompleteTelegramTargetPlanPage(db, claim, NOW + 1)).resolves.toMatchObject({
      found: true,
      complete: true,
      pageIndex: 0,
    });
    expect(sqlite.prepare("SELECT status FROM telegram_alert_target_plan_pages").get()).toEqual({ status: "complete" });

    sqlite.exec(`UPDATE telegram_alert_target_plan_pages SET status = 'materializing', completed_at = NULL;
      UPDATE telegram_alert_source_events SET target_plan_owner = 'different-owner', planning_cursor_chat_id = NULL;`);
    await expect(reconcileIncompleteTelegramTargetPlanPage(db, claim, NOW + 2)).rejects.toThrow(
      "resume CAS was not confirmed",
    );
    expect(sqlite.prepare("SELECT status FROM telegram_alert_target_plan_pages").get()).toEqual({
      status: "materializing",
    });
  });

  it("resumes only the immutable incomplete-page range after a mid-page crash", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:partial-page";
    insertSource(sqlite, sourceEventId);
    for (const chatId of ["1", "2", "3", "4"]) insertSubscriber(sqlite, chatId);
    const claim = await captureClaim(
      db,
      sourceEventId,
      new Map([
        ["1", true],
        ["2", true],
        ["3", true],
        ["4", true],
      ]),
    );
    const allSubscribers = await loadTelegramPlanningSubscriberPage(db, claim);
    const byChat = new Map(allSubscribers.map((subscriber) => [subscriber.chatId, subscriber]));
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_target_plan_pages (
         source_event_id, plan_generation, page_index, first_chat_id, last_chat_id,
         status, expected_plan_count, expected_target_count, created_at, updated_at
       ) VALUES (?, 1, 0, '1', '3', 'materializing', 3, 3, ?, ?)`,
      )
      .run(sourceEventId, NOW, NOW);

    await materializeTelegramTargetPlanPage(
      db,
      claim,
      0,
      [
        {
          subscriber: byChat.get("1")!,
          currentPreferenceGeneration: 1,
          currentEligible: true,
          routed: [routed("1", sourceEventId, 1, "-1")],
        },
      ],
      NOW,
    );
    const incomplete = await reconcileIncompleteTelegramTargetPlanPage(db, claim, NOW + 1);
    expect(incomplete).toMatchObject({
      found: true,
      complete: false,
      pageIndex: 0,
      firstChatId: "1",
      lastChatId: "3",
    });
    const remainder = await loadTelegramPlanningSubscriberPage(db, claim, 90, {
      firstChatId: incomplete.firstChatId!,
      lastChatId: incomplete.lastChatId!,
    });
    expect(remainder.map((subscriber) => subscriber.chatId)).toEqual(["2", "3"]);
    await materializeTelegramTargetPlanPage(
      db,
      claim,
      0,
      remainder.map((subscriber) => ({
        subscriber,
        currentPreferenceGeneration: 1,
        currentEligible: true,
        routed: [routed(subscriber.chatId, sourceEventId, 1, `-${subscriber.chatId}`)],
      })),
      NOW + 1,
    );
    const nextPage = await loadTelegramPlanningSubscriberPage(db, claim);
    expect(nextPage.map((subscriber) => subscriber.chatId)).toEqual(["4"]);
    await materializeTelegramTargetPlanPage(
      db,
      claim,
      1,
      [
        {
          subscriber: nextPage[0],
          currentPreferenceGeneration: 1,
          currentEligible: true,
          routed: [routed("4", sourceEventId, 1, "-4")],
        },
      ],
      NOW + 2,
    );
    expect(
      sqlite
        .prepare(
          `SELECT page_index, first_chat_id, last_chat_id, expected_plan_count
         FROM telegram_alert_target_plan_pages ORDER BY page_index`,
        )
        .all(),
    ).toEqual([
      { page_index: 0, first_chat_id: "1", last_chat_id: "3", expected_plan_count: 3 },
      { page_index: 1, first_chat_id: "4", last_chat_id: "4", expected_plan_count: 1 },
    ]);
  });

  it("bounds source expiry debt and advances the stored baseline only after reconciliation", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:expiry-debt";
    insertSource(sqlite, sourceEventId, {
      expiresAt: NOW - 1,
      state: "planning",
      generation: 1,
      owner: "owner",
    });
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at
       ) VALUES ('job', 'dews', ?, 'risk', ?, ?)`,
      )
      .run(sourceEventId, NOW - 10, NOW - 1);
    const insertPlan = sqlite.prepare(
      `INSERT INTO telegram_alert_target_plans (
         source_event_id, plan_generation, plan_key, page_index, plan_ordinal,
         chat_id, alert_type, preference_generation, estimated_chunks,
         plan_payload_json, plan_payload_digest, expected_target_count,
         materialized_target_count, created_at, updated_at
       ) VALUES (?, 1, ?, 0, ?, ?, 'dews', 1, 1, '{}', ?, 1, 1, ?, ?)`,
    );
    const insertTarget = sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, source_event_id, plan_generation,
         plan_key, plan_ordinal, target_ordinal, target_expires_at
       ) VALUES ('job', ?, ?, 0, 'dews', 'planned', ?, ?, ?, 1, ?, ?, 0, ?)`,
    );
    for (let index = 0; index < 120; index += 1) {
      const key = `plan-${index}`;
      const chatId = String(10_000 + index);
      insertPlan.run(sourceEventId, key, index, chatId, "a".repeat(64), NOW - 10, NOW - 10);
      insertTarget.run(`target-${index}`, chatId, `pending-${index}`, NOW - 10, sourceEventId, key, index, NOW - 1);
    }

    const first = await expireTelegramTargetPlanSource(db, sourceEventId, 1, NOW, "expired", 90);
    expect(first).toMatchObject({ processed: 90, complete: false });
    expect(first.remaining.targets + first.remaining.plans).toBe(150);
    let expiry = first;
    let calls = 1;
    while (!expiry.complete && calls < 10) {
      expiry = await expireTelegramTargetPlanSource(db, sourceEventId, 1, NOW + calls, "expired", 90);
      calls += 1;
    }
    expect(expiry.complete).toBe(true);
    expect(calls).toBeGreaterThan(1);
    expect(
      sqlite
        .prepare("SELECT state, remaining_targets, remaining_plans FROM telegram_alert_target_expiry_progress")
        .get(),
    ).toEqual({ state: "complete", remaining_targets: 0, remaining_plans: 0 });

    const source = await loadTelegramAlertSourceEvent(db, sourceEventId);
    expect(source).not.toBeNull();
    await expireTelegramAlertSourceEvent(db, source!, NOW + calls);
    expect(
      sqlite
        .prepare("SELECT status, baseline_committed_at FROM telegram_alert_source_events WHERE source_event_id = ?")
        .get(sourceEventId),
    ).toEqual({ status: "expired", baseline_committed_at: NOW + calls });
  });

  it("expires a fully reconciled source through the authoritative fanout path", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:authoritative-expiry";
    insertSource(sqlite, sourceEventId, { expiresAt: NOW - 1 });
    const sourceEvent = await loadTelegramAlertSourceEvent(db, sourceEventId);
    expect(sourceEvent).not.toBeNull();

    await executeAuthoritativeFanoutPath({
      db,
      botToken: "bot-token",
      snapshotState: {
        reserveSourceAssessment: { state: "ok", ageSeconds: 0, generation: "test", envelope: null },
        reserveSourceUnavailable: false,
        safetySourceAssessment: {
          state: "ok", ageSeconds: 0, generation: "test", envelope: null,
          sourcePublicationGenerationId: null, acceptedPublicationGenerationId: null,
          freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC, assessedAtSec: NOW,
        },
        safetySnapshotNeedsSeed: false,
      } as never,
      events: sourceEvent!.events,
      sourceEvent: sourceEvent!,
      suppressedSafetyChangesAtSeed: 0,
      pendingCapacityBefore: await loadTelegramPendingCapacity(db, NOW),
      nowSec: NOW,
      dispatchStartedAtMs: Date.now(),
      chatsWithActiveSnooze: 0,
    }, {
      updatePresetFailureState: async () => undefined,
    });

    expect(
      sqlite
        .prepare("SELECT status, baseline_committed_at FROM telegram_alert_source_events WHERE source_event_id = ?")
        .get(sourceEventId),
    ).toEqual({ status: "expired", baseline_committed_at: NOW });
  });

  it("expires targets before first enqueue and between enqueue pages", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:target-expiry";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "1");
    insertSubscriber(sqlite, "2");
    insertSubscriber(sqlite, "3");
    const claim = await captureClaim(
      db,
      sourceEventId,
      new Map([
        ["1", true],
        ["2", true],
        ["3", true],
      ]),
    );
    const subscribers = await loadTelegramPlanningSubscriberPage(db, claim);
    await materializeTelegramTargetPlanPage(
      db,
      claim,
      0,
      subscribers.map((subscriber, index) => ({
        subscriber,
        currentPreferenceGeneration: 1,
        currentEligible: true,
        routed: [{
          ...routed(subscriber.chatId, sourceEventId, 1, `-${index}`),
          ...(index === 0 ? { alertType: "launch" as const, alertTypes: ["launch"] as const } : {}),
        }],
      })),
      NOW - 1,
    );
    await finalizeTelegramTargetPlanning(db, claim, NOW - 1);
    await openTelegramTargetPlanDelivery(db, claim, NOW - 1);

    const first = await enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW + 90 * 60, 1);
    expect(first.enqueued).toBe(1);
    expect(
      sqlite.prepare("SELECT final_delivery_state FROM telegram_alert_job_targets WHERE chat_id = '1'").get(),
    ).toEqual({ final_delivery_state: "expired" });
    await expireTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW + PENDING_TTL_SEC);
    expect(
      sqlite.prepare("SELECT status, final_delivery_state FROM telegram_alert_job_targets ORDER BY chat_id").all(),
    ).toEqual([
      { status: "expired", final_delivery_state: "expired" },
      { status: "queued", final_delivery_state: null },
      { status: "expired", final_delivery_state: "expired" },
    ]);
  });

  it.each(["live carrier", "expired carrier"] as const)("propagates per-chat backoff to authoritative handoff with %s", async (carrier) => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:chat-backoff";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    const claim = await captureClaim(db, sourceEventId, new Map([["42", true]]));
    const [subscriber] = await loadTelegramPlanningSubscriberPage(db, claim);
    await materializeTelegramTargetPlanPage(
      db,
      claim,
      0,
      [
        {
          subscriber,
          currentPreferenceGeneration: 1,
          currentEligible: true,
          routed: [routed("42", sourceEventId, 1)],
        },
      ],
      NOW,
    );
    await finalizeTelegramTargetPlanning(db, claim, NOW);
    await openTelegramTargetPlanDelivery(db, claim, NOW);
    sqlite
      .prepare(
        `INSERT INTO telegram_pending_alerts (
         chat_id, message_html, created_at, not_before_at, expires_at,
         dedupe_key, updated_at, source_type
       ) VALUES ('42', 'older retry', ?, ?, ?, 'older-retry', ?, 'legacy')`,
      )
      .run(NOW - 60, NOW + 60, carrier === "expired carrier" ? NOW + 30 : NOW + 3_600, NOW - 60);
    if (carrier === "expired carrier") {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES ('telegram:chat-send-backoff:42', ?, ?)")
        .run(String(NOW + 60), NOW);
      sqlite.prepare("DELETE FROM telegram_pending_alerts WHERE expires_at <= ?").run(NOW + 31);
    }

    await enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW + 31);

    expect(
      sqlite
        .prepare(
          `SELECT not_before_at, priority, expires_at
         FROM telegram_pending_alerts WHERE source_event_id = ?`,
        )
        .get(sourceEventId),
    ).toEqual({
      not_before_at: NOW + 60,
      priority: 20,
      expires_at: NOW + PENDING_TTL_SEC,
    });
  });

  it("projects pending ambiguity without false expiry/failure and repairs a crash gap", async () => {
    const { sqlite, db } = setupLatestSchema();
    const sourceEventId = "telegram-source:test:v1:unknown";
    insertSource(sqlite, sourceEventId);
    insertSubscriber(sqlite, "42");
    const claim = await captureClaim(db, sourceEventId, new Map([["42", true]]));
    const [subscriber] = await loadTelegramPlanningSubscriberPage(db, claim);
    await materializeTelegramTargetPlanPage(
      db,
      claim,
      0,
      [
        {
          subscriber,
          currentPreferenceGeneration: 1,
          currentEligible: true,
          routed: [routed("42", sourceEventId, 1)],
        },
      ],
      NOW,
    );
    await finalizeTelegramTargetPlanning(db, claim, NOW);
    await openTelegramTargetPlanDelivery(db, claim, NOW);
    await enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW);
    const pending = sqlite.prepare("SELECT id, dedupe_key FROM telegram_pending_alerts").get() as {
      id: number;
      dedupe_key: string;
    };

    await recordTelegramJobTargetFinalDelivery(
      db,
      {
        pendingDedupeKey: pending.dedupe_key,
        sourceEventId,
      },
      { state: "execution_unknown", at: NOW + 1, error: "timeout" },
    );
    expect(
      sqlite
        .prepare(
          `SELECT status, failed_at, final_delivery_state, final_delivery_at
         FROM telegram_alert_job_targets`,
        )
        .get(),
    ).toEqual({
      status: "queued",
      failed_at: null,
      final_delivery_state: "execution_unknown",
      final_delivery_at: NOW + 1,
    });
    expect(
      sqlite
        .prepare(
          `SELECT status, execution_unknown_count, expired_count, failed_count
         FROM telegram_alert_jobs WHERE source_event_id = ?`,
        )
        .get(sourceEventId),
    ).toEqual({
      status: "degraded",
      execution_unknown_count: 1,
      expired_count: 0,
      failed_count: 0,
    });

    sqlite.exec(`UPDATE telegram_alert_job_targets SET final_delivery_state = NULL,
      final_delivery_at = NULL, final_delivery_error = NULL;
      UPDATE telegram_pending_alerts SET delivery_state = 'execution_unknown',
      delivery_completed_at = ${NOW + 2}, last_error_class = 'network';
      UPDATE telegram_alert_jobs SET status = 'queued', execution_unknown_count = 0;`);
    await expect(reconcileTelegramJobTargetFinalDeliveryFromPending(db, NOW + 3)).resolves.toBe(1);
    expect(
      sqlite
        .prepare(
          `SELECT status, execution_unknown_count, expired_count, failed_count
         FROM telegram_alert_jobs WHERE source_event_id = ?`,
        )
        .get(sourceEventId),
    ).toEqual({
      status: "degraded",
      execution_unknown_count: 1,
      expired_count: 0,
      failed_count: 0,
    });
  });

  it("reconciles exact mutually exclusive buckets while preserving valid metadata", async () => {
    const { sqlite, db } = setupLatestSchema();
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at, metadata
       ) VALUES ('counter-job', 'dews', 'counter-source', 'risk', ?, ?, '{"keep":"yes"}')`,
      )
      .run(NOW, NOW + 100);
    const insert = sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, cancelled_at, final_delivery_state
       ) VALUES ('counter-job', ?, ?, 0, 'dews', ?, ?, ?, ?, ?)`,
    );
    const rows: Array<[string, string, string, number | null, string | null]> = [
      ["planned", "1", "planned", null, null],
      ["queued", "2", "queued", null, null],
      ["accepted", "3", "sent", null, null],
      ["failed", "4", "failed", null, null],
      ["expired", "5", "expired", null, null],
      ["cancelled", "6", "queued", NOW, null],
      ["unknown", "7", "queued", null, "execution_unknown"],
    ];
    for (const [key, chatId, status, cancelledAt, finalState] of rows) {
      insert.run(key, chatId, status, `pending-${key}`, NOW, cancelledAt, finalState);
    }
    await reconcileTelegramAlertJobCounters(db, ["counter-job"], NOW + 1);
    const job = sqlite
      .prepare(
        `SELECT target_count, planned_count, accepted_count, enqueued_count,
              failed_count, cancelled_count, expired_count, execution_unknown_count,
              metadata
         FROM telegram_alert_jobs WHERE job_id = 'counter-job'`,
      )
      .get() as Record<string, number | string>;
    expect(job).toMatchObject({
      target_count: 7,
      planned_count: 1,
      accepted_count: 1,
      enqueued_count: 1,
      failed_count: 1,
      cancelled_count: 1,
      expired_count: 1,
      execution_unknown_count: 1,
    });
    expect(JSON.parse(String(job.metadata))).toMatchObject({
      keep: "yes",
      countersSource: "authoritative-target-rows",
    });
  });

  it("never labels an all-cancelled job sent", async () => {
    const { sqlite, db } = setupLatestSchema();
    sqlite
      .prepare(
        `INSERT INTO telegram_alert_jobs (
         job_id, alert_type, source_event_id, severity, created_at, expires_at, status
       ) VALUES ('cancelled-job', 'dews', 'cancelled-source', 'risk', ?, ?, 'queued')`,
      )
      .run(NOW, NOW + 100);
    const insert = sqlite.prepare(
      `INSERT INTO telegram_alert_job_targets (
         job_id, target_key, chat_id, chunk_index, alert_type, status,
         pending_dedupe_key, created_at, cancelled_at
       ) VALUES ('cancelled-job', ?, ?, 0, 'dews', 'queued', ?, ?, ?)`,
    );
    for (const key of ["a", "b"]) insert.run(key, key, `pending-${key}`, NOW, NOW);
    await reconcileTelegramAlertJobCounters(db, ["cancelled-job"], NOW + 1);
    expect(
      sqlite
        .prepare(
          `SELECT status, cancelled_count, accepted_count, sent_count, enqueued_count
             FROM telegram_alert_jobs WHERE job_id = 'cancelled-job'`,
        )
        .get(),
    ).toEqual({
      status: "expired",
      cancelled_count: 2,
      accepted_count: 0,
      sent_count: 0,
      enqueued_count: 0,
    });
  });

  it.each(["unsubscribe", "snooze"])("resumes a live-generation admission miss after %s without holding peers", async (change) => {
    const { sqlite, db: baseDb } = setupLatestSchema();
    const sourceEventId = `telegram-source:test:v1:admission-${change}`;
    insertSource(sqlite, sourceEventId);
    for (const chatId of ["001", "002"]) insertSubscriber(sqlite, chatId);
    sqlite.exec("UPDATE telegram_subscribers SET global_alert_dews = 1");
    let injected = false;
    const db = {
      ...baseDb,
      batch: async (statements: D1PreparedStatement[]) => {
        if (!injected && statements.length === 10) {
          injected = true;
          sqlite.prepare(`UPDATE telegram_subscribers
            SET preference_generation = preference_generation + 1,
                global_alert_dews = ?, alert_snooze_until_ts = ?
            WHERE chat_id = '002'`).run(change === "unsubscribe" ? 0 : 1, change === "snooze" ? NOW + 3_600 : null);
        }
        return baseDb.batch(statements);
      },
    } as D1Database;
    const plannedChats: string[][] = [];
    const callbacks = {
      resolveInitialEligibility: async (subscribers: readonly { chatId: string; preferenceGeneration: number }[]) =>
        new Map(subscribers.map((subscriber) => [subscriber.chatId, {
          eligible: true, observedPreferenceGeneration: subscriber.preferenceGeneration,
        }])),
      planSubscribers: async (subscribers: readonly TelegramPlanningDecision["subscriber"][]) => {
        plannedChats.push(subscribers.map((subscriber) => subscriber.chatId));
        return subscribers.map((subscriber) => {
          const live = sqlite.prepare(`SELECT preference_generation, global_alert_dews, alert_snooze_until_ts
            FROM telegram_subscribers WHERE chat_id = ?`).get(subscriber.chatId) as {
            preference_generation: number; global_alert_dews: number; alert_snooze_until_ts: number | null;
          };
          const eligible = live.global_alert_dews === 1 && (live.alert_snooze_until_ts ?? 0) <= NOW;
          return {
            subscriber, currentPreferenceGeneration: live.preference_generation, currentEligible: eligible,
            routed: eligible ? [routed(subscriber.chatId, sourceEventId, live.preference_generation)] : [],
          };
        });
      },
    };
    await expect(runTelegramTargetPlanCoordinator({
      db, sourceEventId, nowSec: NOW, callbacks, maxSteps: 2,
    })).resolves.toMatchObject({ state: "planning", enqueued: 0 });
    expect(injected).toBe(true);
    expect(sqlite.prepare(`SELECT chat_id, planning_outcome FROM telegram_alert_planning_subscribers
      ORDER BY chat_id`).all()).toEqual([
      { chat_id: "001", planning_outcome: "target_planned" },
      { chat_id: "002", planning_outcome: "pending" },
    ]);
    expect(sqlite.prepare("SELECT status FROM telegram_alert_target_plan_pages").get()).toEqual({ status: "materializing" });
    const retained = sqlite.prepare("SELECT * FROM telegram_alert_target_plans").all();
    await expect(runTelegramTargetPlanCoordinator({
      db, sourceEventId, nowSec: NOW + 1, callbacks,
    })).resolves.toMatchObject({ state: "delivery_open", enqueued: 1, remainingTargets: 0 });
    expect(plannedChats).toEqual([["001", "002"], ["002"]]);
    expect(sqlite.prepare("SELECT * FROM telegram_alert_target_plans").all()).toEqual(retained);
    expect(sqlite.prepare(`SELECT planning_outcome, planned_preference_generation
      FROM telegram_alert_planning_subscribers WHERE chat_id = '002'`).get()).toEqual({
      planning_outcome: "preference_changed_ineligible", planned_preference_generation: 2,
    });
    expect(sqlite.prepare(`SELECT expected_plan_count, materialized_plan_count,
      expected_target_count, materialized_target_count FROM telegram_alert_target_plan_pages`).get()).toEqual({
      expected_plan_count: 1, materialized_plan_count: 1, expected_target_count: 1, materialized_target_count: 1,
    });
    expect(sqlite.prepare("SELECT last_error_class, target_plan_generation FROM telegram_alert_source_events").get())
      .toEqual({ last_error_class: null, target_plan_generation: 1 });
    expect(sqlite.prepare("SELECT chat_id FROM telegram_pending_alerts").all()).toEqual([{ chat_id: "001" }]);
    await expect(enqueueTelegramAuthoritativeTargets(baseDb, sourceEventId, 1, NOW + 2))
      .resolves.toMatchObject({ enqueued: 0, remaining: 0 });
  });

  it.each(["erased member", "changed capture", "committed plan erased"])(
    "does not excuse corrupt evidence as a generation admission miss: %s", async (corruption) => {
      const { sqlite, db: baseDb } = setupLatestSchema();
      const sourceEventId = `telegram-source:test:v1:corrupt-admission-${corruption}`;
      insertSource(sqlite, sourceEventId);
      insertSubscriber(sqlite, "001");
      const claim = await captureClaim(baseDb, sourceEventId, new Map([["001", true]]));
      const [subscriber] = await loadTelegramPlanningSubscriberPage(baseDb, claim);
      let injected = false;
      const corrupt = () => {
        sqlite.exec("UPDATE telegram_subscribers SET preference_generation = 2");
        if (corruption === "erased member") {
          sqlite.exec("DELETE FROM telegram_alert_planning_subscribers");
        } else if (corruption === "changed capture") {
          sqlite.exec("UPDATE telegram_alert_planning_subscribers SET preference_generation = 99");
        } else {
          sqlite.exec(`DELETE FROM telegram_alert_target_plan_items;
            DELETE FROM telegram_alert_job_targets;
            DELETE FROM telegram_alert_target_plans;
            UPDATE telegram_alert_planning_subscribers SET planning_outcome = 'pending',
              planned_at = NULL, planned_preference_generation = NULL`);
        }
      };
      const db = {
        ...baseDb,
        batch: async (statements: D1PreparedStatement[]) => {
          if (!injected && statements.length === 5) {
            injected = true;
            if (corruption !== "committed plan erased") corrupt();
            const results = await baseDb.batch(statements);
            if (corruption === "committed plan erased") corrupt();
            return results;
          }
          return baseDb.batch(statements);
        },
      } as D1Database;
      await expect(materializeTelegramTargetPlanPage(db, claim, 0, [{
        subscriber, currentPreferenceGeneration: 1, currentEligible: true,
        routed: [routed("001", sourceEventId, 1)],
      }], NOW)).rejects.toThrow("materialization did not reconcile");
      expect(injected).toBe(true);
      expect(sqlite.prepare(`SELECT target_plan_state, last_error_class, target_delivery_opened_at
        FROM telegram_alert_source_events`).get()).toEqual({
        target_plan_state: "degraded", last_error_class: "target_plan_count_mismatch", target_delivery_opened_at: null,
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 0 });
    },
  );
});
