import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const fixtures = createLatestSchemaFixtureTracker();
let sqlite: DatabaseSync;
beforeAll(() => { sqlite = fixtures.open().sqlite; });
afterAll(fixtures.closeAll);

function explainQueryPlan(
  sqlite: DatabaseSync,
  sql: string,
): string {
  const rows = sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{
    detail?: string;
  }>;
  return rows.map((row) => row.detail ?? "").join("\n");
}

describe("surface publication generation indexes", () => {
  it("uses the surface/start index for latest attempted generation lookups", () => {
    const plan = explainQueryPlan(
      sqlite,
      `SELECT generation_id
         FROM surface_publication_generations
        WHERE surface = 'stablecoins'
        ORDER BY started_at DESC
        LIMIT 1`,
    );

    expect(plan).toContain("idx_surface_publication_generations_surface_started");
  });

  it("uses the surface/state/published index for latest published generation lookups", () => {
    const plan = explainQueryPlan(
      sqlite,
      `SELECT generation_id
         FROM surface_publication_generations
        WHERE surface = 'stablecoins' AND state = 'published'
        ORDER BY published_at DESC, started_at DESC
        LIMIT 1`,
    );

    expect(plan).toContain("idx_surface_publication_generations_surface_state_published");
  });

  it("uses the surface/state/start index for latest failed candidate lookups", () => {
    const plan = explainQueryPlan(
      sqlite,
      `SELECT generation_id
         FROM surface_publication_generations
        WHERE surface = 'stablecoins' AND state = 'failed'
        ORDER BY started_at DESC
        LIMIT 1`,
    );

    expect(plan).toContain("idx_surface_publication_generations_surface_state_started");
  });
});
