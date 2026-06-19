import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { loadPerCoinExplicitlyOffMap } from "../dispatch-telegram-subscribers";

describe("dispatch telegram subscriber loaders", () => {
  it("requires an explicit override marker before treating zero alert flags as off", async () => {
    const db = mockD1([
      {
        match: "AND alert_depeg = 0\n            AND alert_depeg_override = 1",
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "explicit-off" }],
      },
    ]);

    const result = await loadPerCoinExplicitlyOffMap(db, ["usdc-circle"], "depeg");

    expect(result.get("usdc-circle")).toEqual(new Set(["explicit-off"]));
    const query = db.getHistory()[0]?.sql ?? "";
    expect(query).toContain("alert_depeg = 0");
    expect(query).toContain("alert_depeg_override = 1");
  });
});
