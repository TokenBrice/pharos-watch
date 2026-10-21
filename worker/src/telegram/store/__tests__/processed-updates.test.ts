import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_PROCESSING_STALE_SEC } from "../../common/constants";
import {
  claimTelegramProcessedUpdate,
  markTelegramProcessedUpdateProcessed,
  releaseTelegramProcessedUpdate,
} from "../processed-updates";

const NOW = 1_800_000_000;
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function open() {
  const { sqlite } = fixtures.open();
  return { sqlite, db: createSqliteD1(sqlite) };
}

const claimInput = (nowSec = NOW) => ({ updateId: 7, nowSec, updateType: "message", chatId: "42" });

describe("telegram processed-update claim", () => {
  it("acks a processed update as a duplicate", async () => {
    const { sqlite, db } = open();
    await expect(claimTelegramProcessedUpdate(db, claimInput())).resolves.toEqual({ status: "claimed" });
    await markTelegramProcessedUpdateProcessed(db, { updateId: 7, claimedAt: NOW, nowSec: NOW, errorClass: null });

    await expect(claimTelegramProcessedUpdate(db, claimInput(NOW + 3_600))).resolves.toEqual({ status: "duplicate" });
    expect(sqlite.prepare("SELECT status, processed_at, chat_id FROM telegram_processed_updates").all())
      .toEqual([{ status: "processed", processed_at: NOW, chat_id: "42" }]);
  });

  it("asks Telegram to retry while a fresh claim is in flight", async () => {
    const { db } = open();
    await claimTelegramProcessedUpdate(db, claimInput());

    await expect(claimTelegramProcessedUpdate(db, claimInput(NOW + 10))).resolves.toEqual({
      status: "in_flight",
      retryAfterSec: TELEGRAM_PROCESSING_STALE_SEC - 10,
    });
  });

  it("lets the redelivery run after a released claim", async () => {
    const { sqlite, db } = open();
    await claimTelegramProcessedUpdate(db, claimInput());
    await releaseTelegramProcessedUpdate(db, { updateId: 7, claimedAt: NOW });

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM telegram_processed_updates").get()).toEqual({ count: 0 });
    await expect(claimTelegramProcessedUpdate(db, claimInput(NOW + 1))).resolves.toEqual({ status: "claimed" });
  });

  it("never releases a processed update", async () => {
    const { db } = open();
    await claimTelegramProcessedUpdate(db, claimInput());
    await markTelegramProcessedUpdateProcessed(db, { updateId: 7, claimedAt: NOW, nowSec: NOW });
    await releaseTelegramProcessedUpdate(db, { updateId: 7, claimedAt: NOW });

    await expect(claimTelegramProcessedUpdate(db, claimInput(NOW + 1))).resolves.toEqual({ status: "duplicate" });
  });

  it("leaves a fresh reclaimer's row alone when a stale request finishes or fails late", async () => {
    const { sqlite, db } = open();
    await claimTelegramProcessedUpdate(db, claimInput());
    const reclaimAt = NOW + TELEGRAM_PROCESSING_STALE_SEC + 5;
    await expect(claimTelegramProcessedUpdate(db, claimInput(reclaimAt))).resolves.toEqual({ status: "claimed" });

    // The original (slow) request now completes, then fails: neither touches the new claim.
    await markTelegramProcessedUpdateProcessed(db, { updateId: 7, claimedAt: NOW, nowSec: reclaimAt + 1 });
    await releaseTelegramProcessedUpdate(db, { updateId: 7, claimedAt: NOW });
    expect(sqlite.prepare("SELECT status, received_at FROM telegram_processed_updates").get())
      .toEqual({ status: "processing", received_at: reclaimAt });

    await markTelegramProcessedUpdateProcessed(db, { updateId: 7, claimedAt: reclaimAt, nowSec: reclaimAt + 2 });
    expect(sqlite.prepare("SELECT status FROM telegram_processed_updates").get()).toEqual({ status: "processed" });
  });

  it.each([
    ["stale processing (crashed request)", "processing", "unstarted", NOW - TELEGRAM_PROCESSING_STALE_SEC],
    ["legacy effect-fence planned row", "processing", "planned", NOW - 7 * 86_400],
    ["legacy failed row", "failed", "unstarted", NOW - 5],
  ])("reclaims a %s instead of blocking the update", async (_label, status, effectState, receivedAt) => {
    const { sqlite, db } = open();
    sqlite.prepare(`INSERT INTO telegram_processed_updates
      (update_id, received_at, update_type, chat_id, status, effect_state, claim_owner, claim_generation, intent_mutates)
      VALUES (7, ?, 'my_chat_member', '42', ?, ?, 'old-owner', 1, 1)`).run(receivedAt, status, effectState);

    await expect(claimTelegramProcessedUpdate(db, claimInput())).resolves.toEqual({ status: "claimed" });
    expect(sqlite.prepare("SELECT status, received_at, update_type FROM telegram_processed_updates").get())
      .toEqual({ status: "processing", received_at: NOW, update_type: "message" });
  });
});
