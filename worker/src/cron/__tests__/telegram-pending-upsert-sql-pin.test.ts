import { afterEach, describe, expect, it } from "vitest";
import { buildDedupeKey, buildPendingAlertEnqueueStatement } from "../../lib/telegram/pending-queue";
import { buildSetBasedPendingHandoffStatements } from "../telegram-alert-target-plans/delivery";
import { createLatestSchemaFixtureTracker } from "../../test-helpers/latest-schema-sqlite";
import { insertAlertJobTargetFixture, insertPendingSqlite, insertSourceEventSqlite } from "./telegram-pending-queue.test-support";
import { serializePendingAlertScope, serializePendingMarkupPolicy } from "../../lib/telegram/pending-provenance";

const { open, closeAll } = createLatestSchemaFixtureTracker();
afterEach(closeAll);
const NOW = 10_000;
const message = {
  chatId: "collision", html: "Fresh content", canonicalHtml: "Canonical", disableNotification: true,
  alertType: "depeg" as const, chunkIndex: 2, sourceEventId: "source-new", preferenceGeneration: 7,
  alertScope: [{ stablecoinId: "usdc-circle", family: "depeg" as const }],
};

describe.each(["enqueue", "handoff"] as const)("%s pending collision semantics", (producer) => {
  it.each(["live", "expired", "claimed", "sending", "priority"] as const)("preserves the %s row contract", async (scenario) => {
    const { sqlite, db } = open();
    const dedupeKey = buildDedupeKey(message);
    insertPendingSqlite(sqlite, {
      id: 1, chatId: "collision", html: "Original", createdAt: NOW - 60,
      expiresAt: scenario === "expired" ? NOW : NOW + 600,
      dedupeKey, attempts: 4, notBeforeAt: NOW + 300, priority: scenario === "priority" ? 100 : 10,
      sourceType: scenario === "priority" ? "admin_broadcast" : "risk_alert", sourceEventId: "source-old",
      preferenceGeneration: 2,
    });
    if (scenario === "claimed" || scenario === "expired" || scenario === "sending") {
      sqlite.prepare("UPDATE telegram_pending_alerts SET processing_owner = 'owner', processing_started_at = ?, processing_expires_at = ?").run(NOW - 30, NOW + 300);
    }
    if (scenario === "sending") {
      sqlite.prepare("UPDATE telegram_pending_alerts SET delivery_state = 'sending', delivery_owner = 'owner', delivery_generation = 4").run();
    }
    const before = sqlite.prepare("SELECT * FROM telegram_pending_alerts").get();
    if (producer === "enqueue") {
      await buildPendingAlertEnqueueStatement(db, message, NOW, { ttlSec: 600 }).run();
    } else {
      insertSourceEventSqlite(sqlite, { sourceEventId: "source-new", planGeneration: 3 }, NOW);
      insertAlertJobTargetFixture(sqlite, {
        jobId: "job", targetKey: "target", chatId: message.chatId, alertType: "depeg", status: "planned",
        pendingDedupeKey: dedupeKey, sourceEventId: "source-new", planGeneration: 3,
        messageHtml: message.html, disableNotification: 1, chunkIndex: 2, preferenceGeneration: 7,
        alertScopeJson: serializePendingAlertScope(message.alertScope), markupPolicyJson: serializePendingMarkupPolicy({}),
      }, NOW);
      sqlite.prepare("UPDATE telegram_alert_job_targets SET target_expires_at = ?").run(NOW + 600);
      await db.batch(buildSetBasedPendingHandoffStatements(db, "source-new", 3, NOW, ["target"]));
    }
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_pending_alerts").get()).toEqual({ count: 1 });
    if (scenario === "claimed" || scenario === "sending") {
      expect(sqlite.prepare("SELECT * FROM telegram_pending_alerts").get()).toEqual(before);
    } else {
      expect(sqlite.prepare(`SELECT chat_id, message_html, disable_notification, chunk_index, priority, source_type,
        attempts, not_before_at, created_at, expires_at, processing_owner, source_event_id, preference_generation
        FROM telegram_pending_alerts`).get()).toEqual({
        chat_id: "collision", message_html: "Fresh content", disable_notification: 1, chunk_index: 2,
        priority: 10, source_type: "risk_alert", attempts: scenario === "expired" ? 0 : 4,
        not_before_at: scenario === "expired" ? null : NOW + 300,
        created_at: scenario === "expired" ? NOW : NOW - 60, expires_at: NOW + 600, processing_owner: null,
        source_event_id: scenario === "expired" ? "source-new" : "source-old",
        preference_generation: scenario === "expired" ? 7 : 2,
      });
    }
  });
});

it("assigns each handed-off alert family its delivery priority", async () => {
  const { sqlite, db } = open();
  const families = ["depeg", "dews", "freeze", "launch", "reserve", "safety"];
  insertSourceEventSqlite(sqlite, { sourceEventId: "priorities", planGeneration: 1 }, NOW);
  for (const alertType of families) {
    insertAlertJobTargetFixture(sqlite, {
      jobId: alertType, targetKey: alertType, chatId: alertType, alertType, status: "planned",
      pendingDedupeKey: alertType, sourceEventId: "priorities", planGeneration: 1,
      messageHtml: alertType, disableNotification: 0, preferenceGeneration: 0,
    }, NOW);
  }
  await db.batch(buildSetBasedPendingHandoffStatements(db, "priorities", 1, NOW, families));
  expect(sqlite.prepare("SELECT alert_type, priority FROM telegram_pending_alerts ORDER BY alert_type").all()).toEqual([
    { alert_type: "depeg", priority: 10 },
    { alert_type: "dews", priority: 20 },
    { alert_type: "freeze", priority: 10 },
    { alert_type: "launch", priority: 30 },
    { alert_type: "reserve", priority: 30 },
    { alert_type: "safety", priority: 20 },
  ]);
});
