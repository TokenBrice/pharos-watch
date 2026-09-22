import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { describe, expect, it } from "vitest";
import { pruneOverflowPlanBacklogForChat } from "../telegram/overflow-plan-cache";

describe("pruneOverflowPlanBacklogForChat", () => {
  it("does not resurrect a forgotten plan when concurrent prunes race", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "telegram:dispatch-overflow-plan",
        JSON.stringify({
          version: 1,
          writtenAt: 900,
          plans: [{ chatId: "forgotten-a" }, { chatId: "forgotten-b" }],
        }),
        900,
      );

      await Promise.all([
        pruneOverflowPlanBacklogForChat(db, "forgotten-a", 1_000),
        pruneOverflowPlanBacklogForChat(db, "forgotten-b", 1_000),
      ]);

      const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?")
        .get("telegram:dispatch-overflow-plan") as { value: string };
      expect(JSON.parse(row.value)).toMatchObject({ version: 1, plans: [] });
    } finally {
      sqlite.close();
    }
  });
});
