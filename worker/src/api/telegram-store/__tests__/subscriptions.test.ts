import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database } from "../../../test-helpers/__shared/mock-d1";
import { applySettingToSubscriptions } from "../subscriptions";
import { prepareCoinSettingStatements } from "../../telegram-webhook-settings-mutations";
import type { ParsedSetCommand } from "../../telegram-webhook-shared";
import type { ResolvedCoin } from "../../../lib/telegram-alerts";

const COIN: ResolvedCoin = {
  id: "usdc-circle",
  symbol: "USDC",
  name: "USD Coin",
};

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function subscriptionInsert(db: MockD1Database): { sql: string; binds: unknown[] } {
  const insert = db
    .getHistory()
    .find((entry) => entry.sql.includes("INSERT INTO telegram_subscriptions"));
  if (!insert) throw new Error("expected telegram_subscriptions insert");
  return insert;
}

function expectPreferenceGenerationBump(db: MockD1Database): void {
  const subscriber = db
    .getHistory()
    .find((entry) => entry.sql.includes("INSERT INTO telegram_subscribers"));
  expect(subscriber?.sql).toContain(
    "preference_generation = telegram_subscribers.preference_generation + 1",
  );
  expect(subscriber?.binds[(subscriber?.binds.length ?? 0) - 1]).toBe(1);
}

async function settingsPath(setting: string, value: string): Promise<{ sql: string; binds: unknown[] }> {
  const db = mockD1();
  const prepared = prepareCoinSettingStatements(db, "42", "alice", COIN.id, setting, value);
  expect(prepared.description).not.toBeNull();
  await db.batch(prepared.statements);
  expectPreferenceGenerationBump(db);
  return subscriptionInsert(db);
}

async function setCommandPath(command: ParsedSetCommand): Promise<{ sql: string; binds: unknown[] }> {
  const db = mockD1();
  await applySettingToSubscriptions(db, "42", "alice", [COIN], command);
  expectPreferenceGenerationBump(db);
  return subscriptionInsert(db);
}

describe("per-coin subscription setting builders", () => {
  it("emits identical depeg-off SQL from /set and /settings", async () => {
    const fromSettings = await settingsPath("ds", "0");
    const fromSet = await setCommandPath({
      ticker: "USDC",
      setting: "depeg",
      enabled: false,
    });

    expect(normalizeSql(fromSettings.sql)).toBe(normalizeSql(fromSet.sql));
    expect(fromSettings.binds).toEqual(fromSet.binds);
    expect(fromSet.binds).toEqual(["42", COIN.id, 0]);
  });

  it("emits identical depeg-step SQL from /set and /settings", async () => {
    const fromSettings = await settingsPath("ds", "250");
    const fromSet = await setCommandPath({
      ticker: "USDC",
      setting: "depeg-step",
      enabled: true,
      step: 250,
    });

    expect(normalizeSql(fromSettings.sql)).toBe(normalizeSql(fromSet.sql));
    expect(fromSettings.binds).toEqual(fromSet.binds);
    expect(fromSet.binds).toEqual(["42", COIN.id, 250]);
  });

  it("marks settings-style off writes as explicit overrides", async () => {
    const dewsOff = await setCommandPath({ ticker: "USDC", setting: "dews", enabled: false, minBand: null });
    expect(normalizeSql(dewsOff.sql)).toContain("alert_dews_override = 1");

    const depegOff = await setCommandPath({ ticker: "USDC", setting: "depeg", enabled: false });
    expect(normalizeSql(depegOff.sql)).toContain("alert_depeg_override = 1");

    const safetyOff = await setCommandPath({ ticker: "USDC", setting: "safety", enabled: false, mode: null });
    expect(normalizeSql(safetyOff.sql)).toContain("alert_safety_override = 1");

    const launchOff = await setCommandPath({ ticker: "USDC", setting: "launch", enabled: false });
    expect(normalizeSql(launchOff.sql)).toContain("alert_launch_override = 1");

    const reserveOff = await setCommandPath({ ticker: "USDC", setting: "reserve", enabled: false });
    expect(normalizeSql(reserveOff.sql)).toContain("alert_reserve_override = 1");
  });
});
