import { describe, expect, it, beforeEach } from "vitest";
import {
  handleCallbackQuery,
  makeCallbackQuery,
  mockTelegramD1,
  resetCallbackTest,
} from "./telegram-webhook-callbacks.test-support";



















beforeEach(resetCallbackTest);

describe("handleCallbackQuery", () => {
  describe("P1.17 mutating callbacks emit usage analytics", () => {
    it("depegstep:<id>:250 success records a subscribe usage event", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("depegstep:usdc-circle:250", { id: "cb-depegstep-ok", message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

      const history = db.getHistory();
      const subscriptionUpsert = history.find(
        (entry) =>
          entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.sql.includes("depeg_worsening_bps_step"),
      );
      expect(subscriptionUpsert).toBeDefined();
      expect(subscriptionUpsert!.binds).toEqual(["42", "usdc-circle", 250]);
      expect(subscriptionUpsert!.sql).toContain("alert_depeg = 1");
      expect(subscriptionUpsert!.sql).toContain("depeg_worsening_bps_step = excluded.depeg_worsening_bps_step");
      expect(
        history.some(
          (entry) => entry.sql.includes("INSERT INTO telegram_subscribers") && entry.sql.includes("alert_depeg = MAX"),
        ),
      ).toBe(true);

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("subscribe") &&
            entry.binds.includes("depegstep"),
        );
      expect(usageRows).toHaveLength(1);
      // eventType=subscribe, actionDetail=depegstep, outcome=success
      expect(usageRows[0].binds[1]).toBe("subscribe");
      expect(usageRows[0].binds[3]).toBe("depegstep");
      expect(usageRows[0].binds[4]).toBe("success");
    });

    it("safetydown:<id> success records a subscribe usage event", async () => {
      const db = mockTelegramD1([]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("safetydown:usdc-circle", { id: "cb-safetydown-ok", message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

      const history = db.getHistory();
      const subscriptionUpsert = history.find(
        (entry) => entry.sql.includes("INSERT INTO telegram_subscriptions") && entry.sql.includes("safety_mode"),
      );
      expect(subscriptionUpsert).toBeDefined();
      expect(subscriptionUpsert!.binds).toEqual(["42", "usdc-circle", 1, "downgrade-only"]);
      expect(subscriptionUpsert!.sql).toContain("alert_safety = excluded.alert_safety");
      expect(subscriptionUpsert!.sql).toContain("safety_mode = excluded.safety_mode");
      expect(
        history.some(
          (entry) => entry.sql.includes("INSERT INTO telegram_subscribers") && entry.sql.includes("alert_safety = MAX"),
        ),
      ).toBe(true);

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("subscribe") &&
            entry.binds.includes("safetydown"),
        );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].binds[1]).toBe("subscribe");
      expect(usageRows[0].binds[3]).toBe("safetydown");
      expect(usageRows[0].binds[4]).toBe("success");
    });

    it("unsub:<id> success records an unsubscribe usage event", async () => {
      const db = mockTelegramD1([{ match: "FROM telegram_subscriptions", rows: [] }]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("unsub:usdc-circle", { id: "cb-unsub-ok", message: { chat: { id: 42, type: "private" }, message_id: 100 } }));

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("unsubscribe") &&
            entry.binds.includes("callback_unsub"),
        );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].binds[1]).toBe("unsubscribe");
      expect(usageRows[0].binds[3]).toBe("callback_unsub");
      expect(usageRows[0].binds[4]).toBe("success");
    });

    it("depegstep:<id>:250 D1 failure records a failure usage event", async () => {
      const db = mockTelegramD1([
        {
          match: "INSERT INTO telegram_subscriptions",
          rows: [],
          throwError: new Error("d1 boom"),
        },
      ]);
      await handleCallbackQuery(db, "fake-token", makeCallbackQuery("depegstep:usdc-circle:250", { id: "cb-depegstep-fail", message: { chat: { id: 42, type: "private" }, message_id: 1 } }));

      const usageRows = db
        .getHistory()
        .filter(
          (entry) =>
            entry.sql.includes("INSERT INTO telegram_usage_daily") &&
            entry.binds.includes("subscribe") &&
            entry.binds.includes("depegstep") &&
            entry.binds.includes("failure"),
        );
      expect(usageRows).toHaveLength(1);
      expect(usageRows[0].binds[1]).toBe("subscribe");
      expect(usageRows[0].binds[3]).toBe("depegstep");
      expect(usageRows[0].binds[4]).toBe("failure");
      expect(usageRows[0].binds[6]).toBe("d1_write_failed");
    });
  });

});
