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

async function settingsPath(setting: string, value: string): Promise<{ sql: string; binds: unknown[] }> {
  const db = mockD1();
  const prepared = prepareCoinSettingStatements(db, "42", "alice", COIN.id, setting, value);
  expect(prepared.description).not.toBeNull();
  await db.batch(prepared.statements);
  return subscriptionInsert(db);
}

async function setCommandPath(command: ParsedSetCommand): Promise<{ sql: string; binds: unknown[] }> {
  const db = mockD1();
  await applySettingToSubscriptions(db, "42", "alice", [COIN], command);
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
});
