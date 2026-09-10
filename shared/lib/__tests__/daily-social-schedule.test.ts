import { describe, expect, it } from "vitest";
import { dailySocialPreparationWindow, dailySocialScheduledAt, getDailySocialEdition, isDailySocialDeliveryDue } from "../daily-social-schedule";

const sec = (iso: string) => Date.parse(iso) / 1000;

describe("2 PM Belgrade social schedule", () => {
  it.each([
    ["2026-01-12", "2026-01-12T13:00:00Z"],
    ["2026-07-13", "2026-07-13T12:00:00Z"],
    ["2026-03-28", "2026-03-28T13:00:00Z"],
    ["2026-03-29", "2026-03-29T12:00:00Z"],
    ["2026-10-24", "2026-10-24T12:00:00Z"],
    ["2026-10-25", "2026-10-25T13:00:00Z"],
  ])("converts %s with the applicable daylight-saving offset", (date, utc) => {
    expect(dailySocialScheduledAt(date)).toBe(sec(utc));
  });

  it("selects a unique topic for each local weekday", () => {
    const topics = ["market-growth", "yield-watch", "liquidity-growth", "market-share", "stability", "safety", "market-overview"];
    topics.forEach((topic, i) => expect(getDailySocialEdition(sec(`2026-09-${14 + i}T12:00:00Z`)).topic).toBe(topic));
    expect(getDailySocialEdition(sec("2026-09-13T22:30:00Z")).editionDate).toBe("2026-09-14");
  });

  it("prepares before the deadline and never posts early or after the catch-up window", () => {
    const deadline = sec("2026-09-14T12:00:00Z");
    expect(dailySocialPreparationWindow(deadline - 3601)).toBe(false);
    expect(dailySocialPreparationWindow(deadline - 3600)).toBe(true);
    expect(dailySocialPreparationWindow(deadline - 1)).toBe(true);
    expect(dailySocialPreparationWindow(deadline)).toBe(false);
    expect(isDailySocialDeliveryDue(deadline - 1)).toBe(false);
    expect(isDailySocialDeliveryDue(deadline)).toBe(true);
    expect(isDailySocialDeliveryDue(deadline + 3599)).toBe(true);
    expect(isDailySocialDeliveryDue(deadline + 3600)).toBe(false);
  });

  it.each(["2026-02-30", "nonsense", "2026-13-01"])("rejects invalid date %s", (date) => {
    expect(() => dailySocialScheduledAt(date)).toThrow();
  });
});
