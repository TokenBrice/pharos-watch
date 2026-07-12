import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { releaseFeedbackRateLimit, reserveFeedbackRateLimit } from "../rate-limit";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("feedback rate-limit reservations", () => {
  it("releases exactly one identified reservation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`
      CREATE TABLE feedback_rate_limit (
        ip_hash TEXT NOT NULL,
        submitted_at INTEGER NOT NULL
      );
    `);
    const db = createSqliteD1(sqlite);

    const first = await reserveFeedbackRateLimit(db, "1.2.3.4", "salt", 600, 3);
    const second = await reserveFeedbackRateLimit(db, "1.2.3.4", "salt", 600, 3);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 2 });
    await expect(releaseFeedbackRateLimit(db, first!)).resolves.toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM feedback_rate_limit").get()).toEqual({ count: 1 });
  });
});
