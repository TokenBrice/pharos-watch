import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { applySettingToSubscriptions, prepareSubscriberAndSubscriptionStatements } from "../subscriptions";
import { prepareCoinSettingStatements } from "../../telegram-webhook-settings-mutations";
import type { ParsedSetCommand } from "../../telegram-webhook-shared";

const COIN = { id: "usdc-circle", symbol: "USDC", name: "USD Coin" };
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

function seeded() {
  const fixture = fixtures.open();
  fixture.sqlite.exec(`
    INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at, preference_generation)
    VALUES ('42', 1, 1, 7), ('neighbor', 1, 1, 12);
    INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg, depeg_worsening_bps_step)
    VALUES ('42', 'usdc-circle', 1, 100), ('neighbor', 'usdc-circle', 1, 500);
  `);
  return fixture;
}

describe("per-coin subscription persistence", () => {
  it.each([
    ["off", "0", { ticker: "USDC", setting: "depeg", enabled: false }, 0, null],
    ["step", "250", { ticker: "USDC", setting: "depeg-step", enabled: true, step: 250 }, 1, 250],
  ] as const)("persists %s through both settings consumers", async (_name, value, command, enabled, step) => {
    for (const path of ["settings", "set"]) {
      const { sqlite, db } = seeded();
      if (path === "settings") {
        await db.batch(prepareCoinSettingStatements(db, "42", "alice", COIN.id, "ds", value).statements);
      } else {
        await applySettingToSubscriptions(db, "42", "alice", [COIN], command);
      }
      expect(sqlite.prepare(`SELECT chat_id, alert_depeg, alert_depeg_override, depeg_worsening_bps_step
        FROM telegram_subscriptions ORDER BY chat_id`).all()).toEqual([
        { chat_id: "42", alert_depeg: enabled, alert_depeg_override: 1, depeg_worsening_bps_step: step },
        { chat_id: "neighbor", alert_depeg: 1, alert_depeg_override: 0, depeg_worsening_bps_step: 500 },
      ]);
      expect(sqlite.prepare("SELECT chat_id, preference_generation FROM telegram_subscribers ORDER BY chat_id").all())
        .toEqual([{ chat_id: "42", preference_generation: 8 }, { chat_id: "neighbor", preference_generation: 12 }]);
    }
  });

  it("retains tuning when enabling depeg alerts", async () => {
    const { sqlite, db } = seeded();
    sqlite.exec("UPDATE telegram_subscriptions SET alert_depeg = 0 WHERE chat_id = '42'");
    await applySettingToSubscriptions(db, "42", "alice", [COIN], { ticker: "USDC", setting: "depeg", enabled: true });
    expect(sqlite.prepare("SELECT alert_depeg, depeg_worsening_bps_step FROM telegram_subscriptions WHERE chat_id = '42'").get())
      .toEqual({ alert_depeg: 1, depeg_worsening_bps_step: 100 });
  });

  it.each(["dews", "depeg", "safety", "launch", "reserve", "freeze"] as const)("retains explicit %s off intent", async (setting) => {
    const { sqlite, db } = seeded();
    sqlite.exec(`UPDATE telegram_subscriptions SET alert_${setting} = 1`);
    const command = { ticker: "USDC", setting, enabled: false, minBand: null, mode: null } as ParsedSetCommand;
    await applySettingToSubscriptions(db, "42", "alice", [COIN], command);
    expect(sqlite.prepare(`SELECT chat_id, alert_${setting} AS enabled, alert_${setting}_override AS explicit
      FROM telegram_subscriptions ORDER BY chat_id`).all()).toEqual([
      { chat_id: "42", enabled: 0, explicit: 1 }, { chat_id: "neighbor", enabled: 1, explicit: 0 },
    ]);
  });

  it("persists freeze follow intent by named columns", async () => {
    const { sqlite, db } = seeded();
    await db.batch(prepareSubscriberAndSubscriptionStatements(db, "42", "alice", new Set(["freeze"]), [COIN.id]));
    expect(sqlite.prepare("SELECT alert_freeze, alert_freeze_override FROM telegram_subscriptions WHERE chat_id = '42'").get())
      .toEqual({ alert_freeze: 1, alert_freeze_override: 1 });
  });
});
