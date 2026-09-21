import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { describeGlobalAlertSettings } from "../telegram-webhook-messages";
import { toggleGlobalAlert } from "../telegram-webhook-settings-mutations";
import { loadSubscriberByChat } from "../telegram-store/subscribers";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

describe("loadSubscriberByChat", () => {
  it("loads freeze preferences and toggles an enabled global preference off", async () => {
    const { db, sqlite } = fixtures.open();
    sqlite.exec(`
      INSERT INTO telegram_subscribers (
        chat_id, alert_freeze, global_alert_freeze, created_at, last_active_at
      ) VALUES ('42', 1, 1, 1, 1)
    `);

    const loaded = await loadSubscriberByChat(db, "42");
    expect(loaded).toMatchObject({ alert_freeze: 1, global_alert_freeze: 1 });
    expect(describeGlobalAlertSettings(loaded)).toBe("Freeze");

    await toggleGlobalAlert(db, "42", "alice", "freeze");

    expect(sqlite.prepare(
      "SELECT alert_freeze, global_alert_freeze FROM telegram_subscribers WHERE chat_id = '42'",
    ).get()).toEqual({ alert_freeze: 1, global_alert_freeze: 0 });
  });
});
