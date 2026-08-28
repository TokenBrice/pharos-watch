import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  buildDewsStablecoinIdsDigest,
  reconcileDewsPublishedGenerationLedger,
  readDewsPublishedGenerationResult,
  writeDewsPublishedGeneration,
} from "../dews-publication-pointer";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const nowSec = 1_778_400_000;
const pointerKey = "dews:published-generation";

function pointerMatch(value: string, updatedAt: number, throwError?: unknown) {
  return {
    match: "FROM cache WHERE key = ?",
    matchBinds: [pointerKey],
    rows: [{
      key: pointerKey,
      value,
      updated_at: updatedAt,
    }],
    first: {
      key: pointerKey,
      value,
      updated_at: updatedAt,
    },
    throwError,
  };
}

function pointerPayload(updatedAt: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    updatedAt,
    source: "compute-dews",
    publishStatus: "published",
    ...overrides,
  });
}

function openSqlitePublicationDb(): {
  sqlite: DatabaseSync;
  db: D1Database;
} {
  const sqlite = createLatestSchemaSqlite().sqlite;
  return { sqlite, db: createSqliteD1(sqlite) };
}

describe("DEWS publication pointer reader", () => {
  it("returns ok for a valid published generation pointer", async () => {
    const db = mockD1([
      pointerMatch(pointerPayload(nowSec - 60), nowSec - 60),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toEqual({
      status: "ok",
      computedAt: nowSec - 60,
      expectedRowCount: null,
      stablecoinIdsDigest: null,
    });
  });

  it("returns exact generation coverage from a current pointer", async () => {
    const computedAt = nowSec - 60;
    const stablecoinIds = ["usdt-tether", "usdc-circle"];
    const db = mockD1([
      pointerMatch(pointerPayload(computedAt, {
        coverageVersion: 2,
        expectedRowCount: stablecoinIds.length,
        stablecoinIdsDigest: buildDewsStablecoinIdsDigest(stablecoinIds),
      }), computedAt),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toEqual({
      status: "ok",
      computedAt,
      expectedRowCount: 2,
      stablecoinIdsDigest: buildDewsStablecoinIdsDigest(stablecoinIds),
    });
  });

  it("rejects malformed exact-generation coverage", async () => {
    const computedAt = nowSec - 60;
    const db = mockD1([
      pointerMatch(pointerPayload(computedAt, {
        coverageVersion: 2,
        expectedRowCount: 2,
        stablecoinIdsDigest: "not-a-digest",
      }), computedAt),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toMatchObject({
      status: "invalid-pointer",
      reason: "payload stablecoinIdsDigest is not SHA-256",
    });
  });

  it("distinguishes a missing pointer from invalid pointers", async () => {
    const db = mockD1([
      {
        match: "FROM cache WHERE key = ?",
        matchBinds: [pointerKey],
        rows: [],
        first: null,
      },
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toEqual({
      status: "no-pointer",
    });
  });

  it("rejects future pointers", async () => {
    const db = mockD1([
      pointerMatch(pointerPayload(nowSec + 60), nowSec + 60),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toMatchObject({
      status: "invalid-pointer",
      reason: "payload updatedAt is in the future",
    });
  });

  it("rejects pointers whose payload timestamp differs from cache updated_at", async () => {
    const db = mockD1([
      pointerMatch(pointerPayload(nowSec - 60), nowSec - 30),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toMatchObject({
      status: "invalid-pointer",
      reason: "payload updatedAt does not match cache updated_at",
    });
  });

  it("classifies D1 read failures separately from invalid payloads", async () => {
    const db = mockD1([
      pointerMatch(pointerPayload(nowSec - 60), nowSec - 60, new Error("D1 unavailable")),
    ], { requireMatch: true });

    await expect(readDewsPublishedGenerationResult(db, nowSec)).resolves.toMatchObject({
      status: "read-failed",
      error: "D1 unavailable",
    });
  });

  it("commits the cache pointer and durable ledger row atomically", async () => {
    const { sqlite, db } = openSqlitePublicationDb();
    try {
      sqlite.exec(`
        CREATE TRIGGER fail_dews_ledger
        BEFORE INSERT ON surface_publication_generations
        BEGIN
          SELECT RAISE(ABORT, 'ledger write failed');
        END;
      `);

      await expect(writeDewsPublishedGeneration(
        db,
        nowSec - 60,
        ["usdt-tether", "usdc-circle"],
      )).rejects.toThrow("ledger write failed");
      expect(sqlite.prepare("SELECT key FROM cache WHERE key = ?").get(pointerKey)).toBeUndefined();

      sqlite.exec("DROP TRIGGER fail_dews_ledger");
      await expect(writeDewsPublishedGeneration(
        db,
        nowSec - 60,
        ["usdt-tether", "usdc-circle"],
      )).resolves.toEqual({ written: true, skippedBecauseNewer: false });

      expect(sqlite.prepare(
        `SELECT state, published_rows, artifact_checksum
           FROM surface_publication_generations
          WHERE surface = 'dews' AND generation_id = ?`,
      ).get(`dews:${nowSec - 60}`)).toEqual({
        state: "published",
        published_rows: 2,
        artifact_checksum: buildDewsStablecoinIdsDigest(["usdt-tether", "usdc-circle"]),
      });

      await expect(writeDewsPublishedGeneration(
        db,
        nowSec - 120,
        ["usdt-tether"],
      )).resolves.toEqual({ written: false, skippedBecauseNewer: true });
      expect(sqlite.prepare(
        "SELECT COUNT(*) AS cnt FROM surface_publication_generations WHERE generation_id = ?",
      ).get(`dews:${nowSec - 120}`)).toEqual({ cnt: 0 });
    } finally {
      sqlite.close();
    }
  });

  it("reconciles a valid legacy pointer into the durable ledger", async () => {
    const { sqlite, db } = openSqlitePublicationDb();
    try {
      const computedAt = nowSec - 60;
      sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(
        pointerKey,
        pointerPayload(computedAt),
        computedAt,
      );

      await expect(reconcileDewsPublishedGenerationLedger(db, nowSec)).resolves.toMatchObject({
        status: "ok",
        computedAt,
      });
      expect(sqlite.prepare(
        "SELECT state FROM surface_publication_generations WHERE surface = 'dews' AND generation_id = ?",
      ).get(`dews:${computedAt}`)).toEqual({ state: "published" });
    } finally {
      sqlite.close();
    }
  });
});
