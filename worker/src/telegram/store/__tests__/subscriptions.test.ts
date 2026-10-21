import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { applySettingToSubscriptions, loadSubscriptionsByIds, prepareSubscriberAndSubscriptionStatements } from "../subscriptions";
import { prepareCoinSettingStatements } from "../../webhook/telegram-webhook-settings-mutations";
import type { ParsedSetCommand } from "../../webhook/telegram-webhook-shared";
import type { TelegramMiniAppOperation } from "@shared/lib/telegram-mini-app-contract";
import { applyTelegramMiniAppMutation } from "../../mini-app/telegram-mini-app-mutations";

type SettingCase = {
  name: string;
  callback?: [string, string];
  command: ParsedSetCommand;
  patch: Extract<TelegramMiniAppOperation, { kind: "set-coin" }>["patch"];
  expected: Record<string, unknown>;
};
const settingCases: SettingCase[] = [
  // Launch is retired: no live path writes alert_launch any more.
  ...(["dews", "depeg", "safety", "reserve", "freeze"] as const).flatMap((family): SettingCase[] => {
    const code = { dews: "db", depeg: "ds", safety: "sm", reserve: "rs", freeze: "fz" }[family];
    const off = {
      name: `${family} off`, callback: [code, "0"] as [string, string],
      command: { ticker: "USDC", setting: family, enabled: false, minBand: null, mode: null } as ParsedSetCommand,
      patch: { alertTypes: { [family]: false } },
      expected: {
        [`alert_${family}`]: 0, [`alert_${family}_override`]: 1,
        ...(family === "dews" ? { dews_min_band: null } : family === "safety" ? { safety_mode: null }
          : family === "depeg" ? { depeg_worsening_bps_step: null } : {}),
      },
    };
    return family === "reserve" || family === "freeze"
      ? [off, {
        name: `${family} on`, callback: [code, "1"],
        command: { ticker: "USDC", setting: family, enabled: true }, patch: { [family]: true },
        expected: { [`alert_${family}`]: 1, [`alert_${family}_override`]: 1 },
      }] : [off];
  }),
  ...([["A", "ALERT"], ["W", "WARNING"], ["D", "DANGER"], [null, null]] as const).map(([code, band]): SettingCase => ({
    name: `DEWS ${band}`, callback: code == null ? undefined : ["db", code],
    command: { ticker: "USDC", setting: "dews", enabled: true, minBand: band }, patch: { dewsMinBand: band },
    expected: { alert_dews: 1, alert_dews_override: 1, dews_min_band: band },
  })),
  ...([["a", "all"], ["d", "downgrade-only"], ["u", "upgrade-only"], [null, null]] as const).map(([code, mode]): SettingCase => ({
    name: `safety ${mode}`, callback: code == null ? undefined : ["sm", code],
    command: { ticker: "USDC", setting: "safety", enabled: true, mode }, patch: { safetyMode: mode },
    expected: { alert_safety: 1, alert_safety_override: 1, safety_mode: mode },
  })),
  ...([100, 250, 500, null] as const).map((step): SettingCase => ({
    name: `depeg step ${step}`, callback: step == null ? undefined : ["ds", String(step)],
    command: { ticker: "USDC", setting: "depeg-step", enabled: true, step }, patch: { depegStepBps: step },
    expected: { alert_depeg: 1, alert_depeg_override: 1, depeg_worsening_bps_step: step },
  })),
  {
    name: "depeg on preserves tuning", command: { ticker: "USDC", setting: "depeg", enabled: true },
    patch: { alertTypes: { depeg: true } }, expected: { alert_depeg: 1, alert_depeg_override: 1 },
  },
];

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
  it.each(settingCases)("persists $name identically through /set, settings and Mini App", async ({ callback, command, patch, expected }) => {
    for (const path of ["set", "settings", "mini-app"]) {
      if (path === "settings" && !callback) continue; // The keyboard has no Default/Any/on-without-step action.
      const { db, sqlite } = seeded();
      sqlite.exec(`UPDATE telegram_subscriptions SET alert_dews = 1, alert_safety = 1, alert_launch = 1,
        alert_reserve = 1, alert_freeze = 1, dews_min_band = 'WARNING', safety_mode = 'upgrade-only';
        INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews) VALUES ('42', 'dai-makerdao', 1)`);
      const before = sqlite.prepare("SELECT * FROM telegram_subscriptions ORDER BY chat_id, stablecoin_id").all();
      if (path === "settings") {
        await db.batch(prepareCoinSettingStatements(db, "42", "alice", COIN.id, ...callback!).statements);
      } else if (path === "set") {
        await applySettingToSubscriptions(db, "42", "alice", [COIN], command);
      } else {
        await applyTelegramMiniAppMutation(db, {
          userId: "42", username: "alice", firstName: "Alice", chatType: "private", startParam: null,
          authDate: 1_800_000_000, initDataHash: "test", canMutatePrivateChat: true,
        }, { kind: "set-coin", stablecoinId: COIN.id, patch });
      }
      expect(sqlite.prepare("SELECT * FROM telegram_subscriptions ORDER BY chat_id, stablecoin_id").all())
        .toEqual(before.map((row) => row.chat_id === "42" && row.stablecoin_id === COIN.id ? { ...row, ...expected } : row));
      expect(sqlite.prepare("SELECT chat_id, preference_generation FROM telegram_subscribers ORDER BY chat_id").all())
        .toEqual([{ chat_id: "42", preference_generation: 8 }, { chat_id: "neighbor", preference_generation: 12 }]);
    }
  });

  it.each(["dews", "depeg", "safety", "launch", "reserve", "freeze"] as const)(
    "loads the %s override marker independently from the zero alert flag",
    async (family) => {
      const { db, sqlite } = seeded();
      for (const marker of [0, 1]) {
        sqlite.exec(`UPDATE telegram_subscriptions SET alert_${family} = 0, alert_${family}_override = ${marker} WHERE chat_id = '42'`);
        const rows = await loadSubscriptionsByIds(db, "42", [COIN.id]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ [`alert_${family}`]: 0, [`alert_${family}_override`]: marker });
      }
    },
  );

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
