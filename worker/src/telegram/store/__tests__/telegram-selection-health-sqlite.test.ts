import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { loadSubscriptionRowsByChat } from "../subscriptions";
import { describeSubscriptionSettings } from "../../webhook/telegram-webhook-messages";

const NOW = 1_800_000_000;
const fixtures = createLatestSchemaFixtureTracker();
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});
afterEach(() => {
  fixtures.closeAll();
  vi.useRealTimers();
});

describe("list override projection", () => {
  it.each(["snooze-only", "unmarked", "depeg-off", "all-off"])("matches post-snooze inherited eligibility for %s", async (mode) => {
    const { sqlite, db } = fixtures.open();
    sqlite.prepare(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, global_alert_depeg, global_alert_freeze)
      VALUES ('42', ?, ?, 1, 1)`).run(NOW, NOW);
    sqlite.prepare(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_snooze_until_ts)
      VALUES ('42', 'usdc-circle', ?)`).run(mode === "snooze-only" ? NOW + 3600 : null);
    if (mode === "depeg-off" || mode === "all-off") {
      const columns = mode === "all-off"
        ? TELEGRAM_ALERT_TYPES.map((family) => TELEGRAM_ALERT_PERSISTENCE[family].overrideColumn)
        : [TELEGRAM_ALERT_PERSISTENCE.depeg.overrideColumn];
      sqlite.prepare(`UPDATE telegram_subscriptions SET ${columns.map((column) => `${column} = 1`).join(", ")} WHERE chat_id = '42'`).run();
    }
    const [row] = await loadSubscriptionRowsByChat(db, "42");
    const description = describeSubscriptionSettings(row, NOW, { perCoinTag: true });
    if (mode === "all-off") expect(description).toBe("Muted (overrides defaults)");
    else {
      expect(description).toContain("Inherits preset/global defaults");
      expect(description).not.toContain("Muted");
    }
    if (mode === "depeg-off") expect(description).toContain("off: Depeg");
    if (mode === "snooze-only") expect(description).toContain("snoozed for 1 h");
  });
});
