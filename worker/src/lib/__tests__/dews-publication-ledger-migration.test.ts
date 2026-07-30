import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { buildDewsStablecoinIdsDigest } from "../dews-publication-pointer";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../migrations");
const FIXTURES_DIR = path.resolve(__dirname, "../../test-helpers/migration-fixtures");

// Migrations absorbed by the 2026-07-30 baseline squash live on as frozen test fixtures.
function resolveMigrationPath(file: string): string {
  const fixture = path.join(FIXTURES_DIR, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
  return existsSync(fixture) ? fixture : path.join(MIGRATIONS_DIR, file);
}

function applyMigration(sqlite: DatabaseSync, file: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- trusted worker migration fixture
  sqlite.exec(readFileSync(resolveMigrationPath(file), "utf8"));
}

describe("DEWS publication ledger bootstrap migration", () => {
  it("imports a validated exact pointer and rejects malformed coverage", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE cache (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      applyMigration(sqlite, "0168_surface_publication_generations.sql");
      const computedAt = 1_800_000_000;
      const digest = buildDewsStablecoinIdsDigest(["usdt-tether", "usdc-circle"]);
      const pointer = (stablecoinIdsDigest: string) => JSON.stringify({
        updatedAt: computedAt,
        source: "compute-dews",
        publishStatus: "published",
        coverageVersion: 2,
        expectedRowCount: 2,
        stablecoinIdsDigest,
      });
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        "dews:published-generation",
        pointer("invalid"),
        computedAt,
      );

      applyMigration(sqlite, "0182_dews_published_generation_bootstrap.sql");
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS cnt FROM surface_publication_generations WHERE surface = 'dews'",
      ).get()).toEqual({ cnt: 0 });

      sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(
        pointer(digest),
        "dews:published-generation",
      );
      applyMigration(sqlite, "0182_dews_published_generation_bootstrap.sql");

      expect(sqlite.prepare(
        `SELECT generation_id, state, published_rows, artifact_checksum, artifact_cache_key
           FROM surface_publication_generations
          WHERE surface = 'dews'`,
      ).get()).toEqual({
        generation_id: `dews:${computedAt}`,
        state: "published",
        published_rows: 2,
        artifact_checksum: digest,
        artifact_cache_key: "dews:published-generation",
      });
    } finally {
      sqlite.close();
    }
  });
});
