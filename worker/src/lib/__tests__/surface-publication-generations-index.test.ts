import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

function openSqliteWithMigrations(): import("node:sqlite").DatabaseSync {
  return createLatestSchemaSqlite().sqlite;
}

function explainQueryPlan(
  sqlite: import("node:sqlite").DatabaseSync,
  sql: string,
): string {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
    detail?: string;
  }>;
  return rows.map((row) => row.detail ?? "").join("\n");
}

describe("surface publication generation indexes", () => {
  it("uses the surface/start index for latest attempted generation lookups", () => {
    const sqlite = openSqliteWithMigrations();
    const plan = explainQueryPlan(
      sqlite,
      `SELECT generation_id
         FROM surface_publication_generations
        WHERE surface = 'stablecoins'
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    sqlite.close();

    expect(plan).toContain("idx_surface_publication_generations_surface_started");
  });

  it("uses the surface/state/published index for latest published generation lookups", () => {
    const sqlite = openSqliteWithMigrations();
    const plan = explainQueryPlan(
      sqlite,
      `SELECT generation_id
         FROM surface_publication_generations
        WHERE surface = 'stablecoins' AND state = 'published'
        ORDER BY published_at DESC, started_at DESC
        LIMIT 1`,
    );
    sqlite.close();

    expect(plan).toContain("idx_surface_publication_generations_surface_state_published");
  });

  it("uses the surface/state/start index for latest failed candidate lookups", () => {
    const sqlite = openSqliteWithMigrations();
    const plan = explainQueryPlan(
      sqlite,
      `SELECT generation_id
         FROM surface_publication_generations
        WHERE surface = 'stablecoins' AND state = 'failed'
        ORDER BY started_at DESC
        LIMIT 1`,
    );
    sqlite.close();

    expect(plan).toContain("idx_surface_publication_generations_surface_state_started");
  });
});
