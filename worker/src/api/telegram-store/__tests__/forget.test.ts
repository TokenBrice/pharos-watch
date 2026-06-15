import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { unsubscribeAll } from "../forget";

describe("unsubscribeAll", () => {
  it("clears alert_snooze_until_ts so a re-subscribe is not silently muted", async () => {
    const db = mockD1([]);
    await unsubscribeAll(db, "42");
    const update = db
      .getHistory()
      .find((entry) => /UPDATE telegram_subscribers/.test(entry.sql));
    expect(update).toBeDefined();
    expect(update!.sql).toContain("alert_snooze_until_ts = NULL");
  });
});
