import { describe, expect, it } from "vitest";
import {
  TELEGRAM_ALERT_FAMILIES,
  TELEGRAM_ALERT_PERSISTENCE,
  TELEGRAM_ALERT_TYPE_BY_SETTING_CODE,
} from "@shared/lib/telegram-alert-families";
import { TELEGRAM_ALERT_TYPES } from "@shared/types/status";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";

/**
 * The alert-type registry's column names are load-bearing D1 identifiers: the
 * subscription upsert builder, the mini-app state projection, the /settings
 * surface and the portable-watchlist export all address columns through it. A
 * typo would only surface as a runtime D1 error in production, so the registry
 * is checked against the migrated schema here.
 */

function tableColumns(table: string): Set<string> {
  const { sqlite } = createLatestSchemaSqlite();
  try {
    return new Set(
      sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table).map((row) => String(row.name)),
    );
  } finally {
    sqlite.close();
  }
}

describe("telegram alert-type persistence registry", () => {
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

  it("covers every canonical alert type exactly once", () => {
    expect(Object.keys(TELEGRAM_ALERT_PERSISTENCE).sort()).toEqual([...TELEGRAM_ALERT_TYPES].sort());
    expect(TELEGRAM_ALERT_FAMILIES.map((family) => family.key)).toEqual([...TELEGRAM_ALERT_TYPES]);
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
    // `PlainAlertType` in telegram-store/subscriptions.ts hard-codes this set;
    // adding a tuning column to one of them (or a plain new family) must update
    // both sides together.
    const plain = TELEGRAM_ALERT_TYPES.filter(
      (alertType) => TELEGRAM_ALERT_PERSISTENCE[alertType].settingsColumn == null,
    );
    expect(plain).toEqual(["launch", "reserve", "freeze"]);
  });
});
