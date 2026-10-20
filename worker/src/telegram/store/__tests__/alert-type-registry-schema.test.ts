import { afterAll, describe, expect, it } from "vitest";
import {
  TELEGRAM_ALERT_PERSISTENCE,
  TELEGRAM_ALERT_TYPE_BY_SETTING_CODE,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { PRESET_ALERT_COLUMN } from "../../../cron/telegram/dispatch/telegram-preset-subscriber-store";

/**
 * The alert-type registry's column names are load-bearing D1 identifiers: the
 * subscription upsert builder, the mini-app state projection, the /settings
 * surface and the portable-watchlist export all address columns through it. A
 * typo would only surface as a runtime D1 error in production, so the registry
 * is checked against the migrated schema here.
 */

const { sqlite } = createLatestSchemaSqlite();
afterAll(() => sqlite.close());

function tableColumns(table: string): Set<string> {
  return new Set(
    sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((row) => String(row.name)),
  );
}

describe("telegram alert-type persistence registry", () => {
  it("keeps preset persistence projections valid against the migrated schema", () => {
    const columns = tableColumns("telegram_preset_subscriptions");
    for (const [family, column] of Object.entries(PRESET_ALERT_COLUMN)) {
      expect(column).toBe(TELEGRAM_ALERT_PERSISTENCE[family as keyof typeof PRESET_ALERT_COLUMN].subscriptionColumn);
      expect(columns).toContain(column);
    }
  });

  it("names only real telegram_subscriptions columns", () => {
    const columns = tableColumns("telegram_subscriptions");
    expect(columns.size).toBeGreaterThan(0);
    for (const alertType of TELEGRAM_ALERT_TYPES) {
      const persistence = TELEGRAM_ALERT_PERSISTENCE[alertType];
      expect(columns, `${alertType}.subscriptionColumn`).toContain(persistence.subscriptionColumn);
      expect(columns, `${alertType}.overrideColumn`).toContain(persistence.overrideColumn);
      if (persistence.settingsColumn) {
        expect(columns, `${alertType}.settingsColumn`).toContain(persistence.settingsColumn);
      }
    }
  });

  it("names only real telegram_subscribers columns", () => {
    const columns = tableColumns("telegram_subscribers");
    expect(columns.size).toBeGreaterThan(0);
    for (const alertType of TELEGRAM_ALERT_TYPES) {
      expect(columns, `${alertType}.globalColumn`).toContain(
        TELEGRAM_ALERT_PERSISTENCE[alertType].globalColumn,
      );
    }
  });

  it("keeps setting codes unique and reversible", () => {
    const codes = TELEGRAM_ALERT_TYPES.map((alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].settingCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const alertType of TELEGRAM_ALERT_TYPES) {
      const code = TELEGRAM_ALERT_PERSISTENCE[alertType].settingCode;
      expect(TELEGRAM_ALERT_TYPE_BY_SETTING_CODE[code]).toBe(alertType);
    }
  });

  it("keeps the plain on/off families in step with the settings-column set", () => {
    // `PlainAlertType` in worker/src/telegram/store/subscriptions.ts hard-codes this set;
    // adding a tuning column to one of them (or a plain new family) must update
    // both sides together.
    const plain = TELEGRAM_ALERT_TYPES.filter(
      (alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].settingsColumn == null,
    );
    expect(plain).toEqual(["launch", "reserve", "freeze"]);
  });
});
