import { describe, expect, it } from "vitest";
import { OG_PAGE_LOADERS } from "../index";

describe("upcoming route card", () => {
  it("is timeless by decision and never reads the database", async () => {
    const db = new Proxy({}, { get: () => { throw new Error("db read"); } }) as D1Database;
    await expect(OG_PAGE_LOADERS.upcoming(db, 1_800_000_000)).resolves.toEqual({
      kind: "unavailable",
      reason: "timeless-by-decision",
    });
  });
});
