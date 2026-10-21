import { beforeEach, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  handleCallbackQuery,
  lastAckBody,
  makeCallbackQuery,
  resetCallbackTest,
} from "../../webhook/__tests__/telegram-webhook-callbacks.test-support.ts";

beforeEach(resetCallbackTest);

type SubscriptionRow = {
  alert_depeg: number;
  alert_dews: number;
  alert_safety: number;
  alert_freeze: number;
  alert_freeze_override: number;
  depeg_worsening_bps_step: number | null;
  dews_min_band: string | null;
};

async function tapFewer(data: string, seed?: (sqlite: { exec: (sql: string) => void }) => void) {
  const fixtures = createLatestSchemaFixtureTracker();
  const { sqlite, db } = fixtures.open();
  try {
    sqlite.exec("INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1)");
    seed?.(sqlite);
    await handleCallbackQuery(db, "fake-token", makeCallbackQuery(data));
    const row = sqlite.prepare(
      `SELECT alert_depeg, alert_dews, alert_safety, alert_freeze, alert_freeze_override,
              depeg_worsening_bps_step, dews_min_band
         FROM telegram_subscriptions WHERE chat_id = '42' AND stablecoin_id = 'usdc-circle'`,
    ).get() as SubscriptionRow | undefined;
    return { row, toast: lastAckBody().text };
  } finally {
    fixtures.closeAll();
  }
}

const seedCoin = (columns: string, values: string) => (sqlite: { exec: (sql: string) => void }) =>
  sqlite.exec(`INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, ${columns})
               VALUES ('42', 'usdc-circle', ${values})`);

describe("fewer callback", () => {
  it.each([
    [100, 250, "USDC: depeg alerts now only past 2.5%. Undo in Manage Alerts."],
    [250, 500, "USDC: depeg alerts now only past 5.0%. Undo in Manage Alerts."],
  ] as const)("steps depeg %s bps to %s bps", async (current, next, toast) => {
    const result = await tapFewer(
      "fewer:usdc-circle:ds",
      current == null ? undefined : seedCoin("alert_depeg, depeg_worsening_bps_step", `1, ${current}`),
    );
    expect(result.row?.depeg_worsening_bps_step).toBe(next);
    expect(result.row?.alert_depeg).toBe(1);
    expect(result.toast).toBe(toast);
  });

  it("turns depeg off instead of enabling worsening alerts when no step is in effect", async () => {
    const result = await tapFewer("fewer:usdc-circle:ds", seedCoin("alert_depeg, depeg_worsening_bps_step", "1, NULL"));
    expect(result.row?.alert_depeg).toBe(0);
    expect(result.row?.depeg_worsening_bps_step).toBeNull();
    expect(result.toast).toBe("USDC: depeg alerts off. Undo in Manage Alerts.");
  });

  it.each([
    ["a preset at 500 bps", "INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_depeg, depeg_worsening_bps_step, created_at, updated_at) VALUES ('42', 'usd-top25', 1, 500, 1, 1)", 0, null],
    ["presets at 100 and 250 bps", "INSERT INTO telegram_preset_subscriptions (chat_id, preset_id, alert_depeg, depeg_worsening_bps_step, created_at, updated_at) VALUES ('42', 'usd-top25', 1, 100, 1, 1), ('42', 'usd-top50', 1, 250, 1, 1)", 1, 500],
    ["a global follow at 100 bps", "UPDATE telegram_subscribers SET global_alert_depeg = 1, global_depeg_worsening_bps_step = 100 WHERE chat_id = '42'", 1, 250],
  ] as const)("steps from the strictest inherited depeg step with %s", async (_label, sql, alertDepeg, step) => {
    const result = await tapFewer("fewer:usdc-circle:ds", (sqlite) => sqlite.exec(sql));
    expect(result.row?.alert_depeg).toBe(alertDepeg);
    expect(result.row?.depeg_worsening_bps_step ?? null).toBe(step);
  });

  it("turns depeg off for the coin past the largest step", async () => {
    const result = await tapFewer("fewer:usdc-circle:ds", seedCoin("alert_depeg, depeg_worsening_bps_step", "1, 500"));
    expect(result.row?.alert_depeg).toBe(0);
    expect(result.toast).toBe("USDC: depeg alerts off. Undo in Manage Alerts.");
  });

  it.each([
    [null, "WARNING", "USDC: stress alerts now only at WARNING and above. Undo in Manage Alerts."],
    ["WARNING", "DANGER", "USDC: stress alerts now only at DANGER and above. Undo in Manage Alerts."],
  ] as const)("raises the DEWS floor from %s to %s", async (current, next, toast) => {
    const result = await tapFewer(
      "fewer:usdc-circle:db",
      seedCoin("alert_dews, dews_min_band", `1, ${current == null ? "NULL" : `'${current}'`}`),
    );
    expect(result.row?.alert_dews).toBe(1);
    expect(result.row?.dews_min_band).toBe(next);
    expect(result.toast).toBe(toast);
  });

  it("sets the carried value idempotently instead of stepping again on a repeated tap", async () => {
    const fixtures = createLatestSchemaFixtureTracker();
    const { sqlite, db } = fixtures.open();
    try {
      sqlite.exec(`INSERT INTO telegram_subscribers (chat_id, created_at, last_active_at) VALUES ('42', 1, 1);
        INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_depeg, depeg_worsening_bps_step)
        VALUES ('42', 'usdc-circle', 1, 100)`);
      for (const id of ["cb1", "cb2"]) {
        await handleCallbackQuery(db, "fake-token", makeCallbackQuery("fewer:usdc-circle:ds:250", { id }));
      }
      expect(sqlite.prepare("SELECT depeg_worsening_bps_step FROM telegram_subscriptions WHERE chat_id = '42' AND stablecoin_id = 'usdc-circle'").get())
        .toEqual({ depeg_worsening_bps_step: 250 });
      expect(lastAckBody().text).toBe("USDC: depeg alerts now only past 2.5%. Undo in Manage Alerts.");
    } finally {
      fixtures.closeAll();
    }
  });

  it.each([
    ["a raised depeg step", "fewer:usdc-circle:ds:250", "alert_depeg, alert_depeg_override, depeg_worsening_bps_step", "1, 1, 500", { alert_depeg: 1, depeg_worsening_bps_step: 500 }],
    ["depeg turned off", "fewer:usdc-circle:ds:250", "alert_depeg, alert_depeg_override", "0, 1", { alert_depeg: 0 }],
    ["worsening alerts off (no step)", "fewer:usdc-circle:ds:250", "alert_depeg, alert_depeg_override, depeg_worsening_bps_step", "1, 1, NULL", { alert_depeg: 0, depeg_worsening_bps_step: null }],
    ["a raised DEWS floor", "fewer:usdc-circle:db:W", "alert_dews, alert_dews_override, dews_min_band", "1, 1, 'DANGER'", { alert_dews: 1, dews_min_band: "DANGER" }],
    ["DEWS turned off", "fewer:usdc-circle:db:W", "alert_dews, alert_dews_override", "0, 1", { alert_dews: 0 }],
  ] as const)("never makes a stale tap noisier than %s", async (_label, data, columns, values, expected) => {
    const result = await tapFewer(data, seedCoin(columns, values));
    expect(result.row).toMatchObject(expected);
  });

  it.each(["fewer:usdc-circle:ds:300", "fewer:usdc-circle:db:X", "fewer:usdc-circle:sm:a"])("rejects an invalid carried value %s", async (data) => {
    const result = await tapFewer(data, seedCoin("alert_depeg, alert_dews, alert_safety, depeg_worsening_bps_step", "1, 1, 1, 100"));
    expect(result.row).toMatchObject({ alert_depeg: 1, alert_dews: 1, alert_safety: 1, depeg_worsening_bps_step: 100 });
  });

  it("turns DEWS off for the coin at the DANGER floor", async () => {
    const result = await tapFewer("fewer:usdc-circle:db", seedCoin("alert_dews, dews_min_band", "1, 'DANGER'"));
    expect(result.row?.alert_dews).toBe(0);
  });

  it.each([
    ["sm", "alert_safety", "Safety alerts"],
    ["fz", "alert_freeze", "freeze alerts"],
  ] as const)("turns %s off for the coin", async (code, column, label) => {
    const result = await tapFewer(`fewer:usdc-circle:${code}`, seedCoin(column, "1"));
    expect(result.row?.[column]).toBe(0);
    expect(result.toast).toBe(`USDC: ${label} off. Undo in Manage Alerts.`);
  });

  it("records an explicit per-coin off for a coin followed only through a preset or global", async () => {
    const result = await tapFewer("fewer:usdc-circle:fz");
    expect(result.row?.alert_freeze).toBe(0);
    expect(result.row?.alert_freeze_override).toBe(1);
  });

  it.each(["fewer:usdc-circle", "fewer:usdc-circle:lc", "fewer:not-a-coin:ds", "fewer:usdc-circle:ds:x"])(
    "rejects malformed %s without writing",
    async (data) => {
      const result = await tapFewer(data);
      expect(result.row).toBeUndefined();
      expect(result.toast).toBe("Action not recognized.");
    },
  );
});

describe("legacy alert buttons", () => {
  it("keeps depegstep and safetydown buttons from older alerts working", async () => {
    expect((await tapFewer("depegstep:usdc-circle:250")).row?.depeg_worsening_bps_step).toBe(250);
    expect((await tapFewer("safetydown:usdc-circle")).toast).toBe("Safety alerts set to downgrades only.");
  });
});
