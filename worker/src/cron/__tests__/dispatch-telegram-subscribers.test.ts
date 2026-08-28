import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { loadPerCoinExplicitlyOffMap } from "../dispatch-telegram-subscribers";

describe("dispatch telegram subscriber loaders", () => {
  it.each([
    ["depeg", "alert_depeg", "alert_depeg_override"],
    ["reserve", "alert_reserve", "alert_reserve_override"],
  ] as const)("requires an explicit override marker before treating %s zero flags as off", async (type, alertColumn, overrideColumn) => {
    const db = mockD1([
      {
        match: `AND ${alertColumn} = 0\n            AND ${overrideColumn} = 1`,
        rows: [{ stablecoin_id: "usdc-circle", chat_id: "explicit-off" }],
      },
    ]);

    const result = await loadPerCoinExplicitlyOffMap(db, ["usdc-circle"], type);

    expect(result.get("usdc-circle")).toEqual(new Set(["explicit-off"]));
    const query = db.getHistory()[0]?.sql ?? "";
    expect(query).toContain(`${alertColumn} = 0`);
    expect(query).toContain(`${overrideColumn} = 1`);
  });
});
