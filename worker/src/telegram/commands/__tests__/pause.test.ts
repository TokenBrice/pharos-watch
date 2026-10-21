import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { handlePause } from "../pause";
import { makeCommandContext, buttonsFromMarkup, expectMiniAppButton } from "./webhook-commands.test-support.ts";

const fixtures = createLatestSchemaFixtureTracker();
const NOW = 1_800_000_000;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); });
afterEach(() => { vi.useRealTimers(); fixtures.closeAll(); });

function seeded() {
  const fixture = fixtures.open();
  fixture.sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, alert_snooze_until_ts, preference_generation)
    VALUES ('42', 1, 1, 123, 7), ('neighbor', 1, 1, 456, 9)`);
  return fixture;
}

describe("/pause command", () => {
  it.each([["", PAUSE_SENTINEL_TS], ["off", null], ["resume", null], ["4h", NOW + 14400]] as const)("persists %s only for the current chat", async (arg, until) => {
    const { sqlite, db } = seeded();
    const ctx = makeCommandContext(db);
    await handlePause(ctx, arg);
    expect(sqlite.prepare("SELECT chat_id, alert_snooze_until_ts, preference_generation FROM telegram_subscribers ORDER BY chat_id").all()).toEqual([
      { chat_id: "42", alert_snooze_until_ts: until, preference_generation: 8 },
      { chat_id: "neighbor", alert_snooze_until_ts: 456, preference_generation: 9 },
    ]);
    const options = vi.mocked(ctx.replyToChatWithMarkup).mock.calls[0]?.[1];
    expectMiniAppButton(buttonsFromMarkup(options?.replyMarkup), "Manage Alerts", "snooze");
  });

  it("rejects unknown arguments without changing preferences", async () => {
    const { sqlite, db } = seeded();
    const before = sqlite.prepare("SELECT * FROM telegram_subscribers ORDER BY chat_id").all();
    const ctx = makeCommandContext(db);
    await handlePause(ctx, "forever");
    expect(ctx.replyToChat).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT * FROM telegram_subscribers ORDER BY chat_id").all()).toEqual(before);
  });
});
