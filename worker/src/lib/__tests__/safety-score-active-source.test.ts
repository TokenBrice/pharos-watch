import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { loadActiveSafetyScoreSource } from "../safety-score-active-source";

describe("active Safety Score source", () => {
  it("fails closed without falling back to V8", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();

    await expect(loadActiveSafetyScoreSource(db)).resolves.toEqual({
      kind: "error",
      expectedModel: "v9",
      reason: "v9-snapshot-unavailable",
      snapshot: null,
      detail: "Canonical Safety Score V9 publication is unavailable",
    });
    sqlite.close();
  });
});
