import { afterEach, describe, expect, it, vi } from "vitest";
import { releaseFeedbackRateLimit, reserveFeedbackRateLimit } from "../rate-limit";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  vi.restoreAllMocks();
  fixtures.closeAll();
});

describe("feedback rate-limit reservations", () => {
  it("caps all sources at 30 per rolling hour and releases only confirmed rejected slots", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { db } = fixtures.open();
    const reserve = (i: number) => reserveFeedbackRateLimit(db, `192.0.2.${i}`, "salt", 600, 3);
    const first = await reserve(0);
    for (let i = 1; i < 30; i++) expect(await reserve(i)).not.toBeNull();
    expect(await reserve(30)).toBeNull();
    expect(await releaseFeedbackRateLimit(db, first!)).toBe(true);
    expect(await reserve(30)).not.toBeNull();
    clock.mockReturnValue(1_800_003_599_000);
    expect(await reserve(31)).toBeNull();
    clock.mockReturnValue(1_800_003_600_000);
    expect(await reserve(31)).not.toBeNull();
  });
  it("releases exactly one identified reservation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { sqlite, db } = fixtures.open();

    const first = await reserveFeedbackRateLimit(db, "1.2.3.4", "salt", 600, 3);
    const second = await reserveFeedbackRateLimit(db, "1.2.3.4", "salt", 600, 3);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 2 });
    await expect(releaseFeedbackRateLimit(db, first!)).resolves.toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 1 });
  });

  it("enforces admission quotas per IP and restores only the released slot", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { sqlite, db } = fixtures.open();
    const reserve = (ip = "1.2.3.4") => reserveFeedbackRateLimit(db, ip, "salt", 600, 3);
    const first = await reserve();
    await reserve();
    await reserve();
    expect(await reserve()).toBeNull();
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 3 });
    expect(await reserve("5.6.7.8")).not.toBeNull();
    expect(await releaseFeedbackRateLimit(db, first!)).toBe(true);
    expect(await reserve()).not.toBeNull();
    expect(await reserve()).toBeNull();
    const rows = sqlite.prepare("SELECT * FROM feedback_rate_limit ORDER BY rowid").all();
    expect(await releaseFeedbackRateLimit(db, { ipHash: "absent", submittedAt: first!.submittedAt })).toBe(false);
    expect(sqlite.prepare("SELECT * FROM feedback_rate_limit ORDER BY rowid").all()).toEqual(rows);
  });

  it("expires reservations exactly at the strict window cutoff", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const { db } = fixtures.open();
    const reserve = () => reserveFeedbackRateLimit(db, "1.2.3.4", "salt", 600, 1);
    expect(await reserve()).not.toBeNull();
    clock.mockReturnValue(1_800_000_599_000);
    expect(await reserve()).toBeNull();
    clock.mockReturnValue(1_800_000_600_000);
    expect(await reserve()).not.toBeNull();
  });
});
