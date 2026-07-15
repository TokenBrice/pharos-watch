import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { emptyAlerts, type RoutedSubscriberAlert } from "../dispatch-telegram-routing";
import {
  captureTelegramPlanningSubscriberPage,
  claimTelegramTargetPlanning,
  enqueueTelegramAuthoritativeTargets,
  expireTelegramAuthoritativeTargets,
  expireTelegramTargetPlanSource,
  finalizeTelegramTargetPlanning,
  loadTelegramPlanningSubscriberPage,
  materializeTelegramTargetPlanPage,
  openTelegramTargetPlanDelivery,
  reconcileIncompleteTelegramTargetPlanPage,
  runTelegramTargetPlanCoordinator,
  type TelegramPlanningDecision,
  type TelegramTargetPlanningClaim,
} from "../telegram-alert-target-plans";
import { hasDeferredTelegramAuthoritativeWork } from "../dispatch-telegram-authoritative-path";
import {
  reconcileTelegramAlertJobCounters,
  reconcileTelegramJobTargetFinalDeliveryFromPending,
  recordTelegramJobTargetFinalDelivery,
} from "../telegram-alert-job-target-outcomes";
import {
  expireTelegramAlertSourceEvent,
  loadTelegramAlertSourceEvent,
  resolveTelegramAlertSourcePresetPages,
} from "../telegram-alert-source-events";
import { PENDING_TTL_SEC } from "@shared/lib/telegram-delivery-policy";
import { resolveTelegramTargetExpiresAt } from "../telegram-alert-target-plans/materialization";

const NOW = 1_800_000_000;
const databases: DatabaseSync[] = [];

function setupLatestSchema(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  const migrationDir = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration directory.
  for (const file of readdirSync(migrationDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migration replay.
    sqlite.exec(readFileSync(join(migrationDir, file), "utf8"));
  }
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close();
});

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
  sqlite
    .prepare(
      `INSERT INTO telegram_subscribers (
       chat_id, created_at, last_active_at, preference_generation
     ) VALUES (?, ?, ?, ?)`,
    )
    .run(chatId, createdAt, NOW - 10, generation);
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

describe("authoritative Telegram target plans on latest SQLite schema", () => {
  it("uses the strictest family TTL for a mixed consolidated target", () => {
    expect(
      resolveTelegramTargetExpiresAt({ detectedAt: NOW }, {}, { alertType: "depeg", alertTypes: ["depeg", "launch"] }),
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
        routed: [routed(subscriber.chatId, sourceEventId, 1, `-${index}`)],
        targetExpiresAt: index === 0 ? NOW : index === 1 ? NOW + 100 : NOW + 1,
      })),
      NOW - 1,
    );
    await finalizeTelegramTargetPlanning(db, claim, NOW - 1);
    await openTelegramTargetPlanDelivery(db, claim, NOW - 1);

    const first = await enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW, 1);
    expect(first.enqueued).toBe(1);
    expect(
      sqlite.prepare("SELECT final_delivery_state FROM telegram_alert_job_targets WHERE chat_id = '1'").get(),
    ).toEqual({ final_delivery_state: "expired" });
    await expireTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW + 2);
    expect(
      sqlite.prepare("SELECT status, final_delivery_state FROM telegram_alert_job_targets ORDER BY chat_id").all(),
    ).toEqual([
      { status: "expired", final_delivery_state: "expired" },
      { status: "queued", final_delivery_state: null },
      { status: "expired", final_delivery_state: "expired" },
    ]);
  });

  it("propagates existing per-chat backoff to authoritative target handoff", async () => {
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
      .run(NOW - 60, NOW + 300, NOW + 3_600, NOW - 60);

    await enqueueTelegramAuthoritativeTargets(db, sourceEventId, 1, NOW);

    expect(
      sqlite
        .prepare(
          `SELECT not_before_at, priority, expires_at
         FROM telegram_pending_alerts WHERE source_event_id = ?`,
        )
        .get(sourceEventId),
    ).toEqual({
      not_before_at: NOW + 300,
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
});
