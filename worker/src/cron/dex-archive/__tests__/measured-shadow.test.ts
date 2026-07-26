import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../../test-helpers/latest-schema-sqlite";
import { pruneDexMeasuredExecutionGenerations } from "../../measured-execution/persistence";
import { runDexArchive } from "../job";
import {
  listMeasuredArchiveCandidates,
  loadMeasuredArchiveArtifact,
} from "../measured";
import { archiveMeasuredObject } from "../r2";

const NOW = 1_800_000_000;
const OLD = NOW - 4 * 60 * 60;
const QUOTE_SURFACE = "dex-measured-execution-quotes";
const TARGET_SURFACE = "dex-measured-execution-targets";

interface StoredObject {
  bytes: Uint8Array;
  etag: string;
  customMetadata?: Record<string, string>;
  httpMetadata?: R2HTTPMetadata;
}

class MemoryR2 {
  readonly objects = new Map<string, StoredObject>();
  putCalls = 0;
  corruptReads = false;

  private object(key: string, stored: StoredObject): R2Object {
    return {
      key,
      version: "1",
      size: stored.bytes.byteLength,
      etag: stored.etag,
      httpEtag: `"${stored.etag}"`,
      checksums: { toJSON: () => ({}) },
      uploaded: new Date(NOW * 1_000),
      httpMetadata: stored.httpMetadata,
      customMetadata: stored.customMetadata,
      storageClass: "Standard",
      writeHttpMetadata: () => undefined,
    } as unknown as R2Object;
  }

  async put(
    key: string,
    value: ArrayBufferView,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    this.putCalls += 1;
    if (this.objects.has(key) && (options?.onlyIf as R2Conditional | undefined)?.etagDoesNotMatch === "*") {
      return null;
    }
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    const stored = {
      bytes,
      etag: `etag-${this.objects.size + 1}`,
      customMetadata: options?.customMetadata,
      httpMetadata: options?.httpMetadata as R2HTTPMetadata | undefined,
    };
    this.objects.set(key, stored);
    return this.object(key, stored);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const stored = this.objects.get(key);
    if (!stored) return null;
    const object = this.object(key, stored);
    return {
      ...object,
      bodyUsed: false,
      body: new Blob([stored.bytes]).stream(),
      bytes: async () => {
        const bytes = stored.bytes.slice();
        if (this.corruptReads && bytes.length > 0) bytes[0] = bytes[0]! ^ 0xff;
        return bytes;
      },
    } as unknown as R2ObjectBody;
  }

  bucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

function insertGeneration(
  sqlite: import("node:sqlite").DatabaseSync,
  input: {
    surface: string;
    generationId: string;
    state?: "published" | "superseded" | "candidate";
    startedAt?: number;
    expectedRows: number;
    publishedRows?: number | null;
    dependencyGenerationId?: string;
  },
): void {
  sqlite.prepare(
    `INSERT INTO surface_publication_generations
       (surface, generation_id, started_at, validated_at, published_at, state,
        published_rows, expected_rows, dependency_snapshot_json, worker_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.surface,
    input.generationId,
    input.startedAt ?? OLD,
    input.state === "candidate" ? null : input.startedAt ?? OLD,
    input.state === "candidate" ? null : input.startedAt ?? OLD,
    input.state ?? "superseded",
    input.publishedRows === undefined ? input.expectedRows : input.publishedRows,
    input.expectedRows,
    input.dependencyGenerationId
      ? JSON.stringify({ targetGenerationId: input.dependencyGenerationId })
      : null,
    "worker-test",
  );
}

function insertBundle(
  sqlite: import("node:sqlite").DatabaseSync,
  suffix: string,
  rowCount = 2,
  startedAt = OLD,
): { quoteGenerationId: string; targetGenerationId: string } {
  const quoteGenerationId = `quote-${suffix}`;
  const targetGenerationId = `target-${suffix}`;
  insertGeneration(sqlite, {
    surface: TARGET_SURFACE,
    generationId: targetGenerationId,
    expectedRows: rowCount,
    startedAt,
  });
  insertGeneration(sqlite, {
    surface: QUOTE_SURFACE,
    generationId: quoteGenerationId,
    expectedRows: rowCount,
    dependencyGenerationId: targetGenerationId,
    startedAt,
  });
  const insertTarget = sqlite.prepare(
    `INSERT INTO dex_measured_execution_targets
       (generation_id, target_id, stablecoin_id, adapter_profile_id, protocol, chain,
        pool_id, captured_at, target_json)
     VALUES (?, ?, 'coin', 'adapter', 'protocol', 'ethereum', 'pool', ?, ?)`,
  );
  const insertQuote = sqlite.prepare(
    `INSERT INTO dex_measured_execution_quotes
       (generation_id, target_generation_id, target_id, stablecoin_id, adapter_profile_id,
        protocol, chain, pool_id, status, quoted_at, quote_profile_json)
     VALUES (?, ?, ?, 'coin', 'adapter', 'protocol', 'ethereum', 'pool', 'measured', ?, ?)`,
  );
  for (let index = rowCount - 1; index >= 0; index -= 1) {
    const targetId = `target-${index.toString().padStart(3, "0")}`;
    insertTarget.run(
      targetGenerationId,
      targetId,
      startedAt,
      JSON.stringify({ targetId, index }),
    );
    insertQuote.run(
      quoteGenerationId,
      targetGenerationId,
      targetId,
      startedAt,
      JSON.stringify({ targetId, index }),
    );
  }
  return { quoteGenerationId, targetGenerationId };
}

describe("measured DEX archive shadow", () => {
  it("pages deterministic rows and round-trips one exact quote/target closure", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const ids = insertBundle(sqlite, "paged", 70);
      const candidates = await listMeasuredArchiveCandidates(db, NOW, 12);
      expect(candidates.map((candidate) => candidate.generationId)).toEqual([ids.quoteGenerationId]);
      const loaded = await loadMeasuredArchiveArtifact(db, candidates[0]!, NOW);
      const quoteTable = loaded.artifactInput.tables.find(
        (table) => table.name === "dex_measured_execution_quotes",
      );
      expect(quoteTable?.rows).toHaveLength(70);
      expect(quoteTable?.rows[0]?.[2]).toBe("target-000");
      expect(quoteTable?.rows[69]?.[2]).toBe("target-069");

      const bucket = new MemoryR2();
      const first = await archiveMeasuredObject({
        db,
        bucket: bucket.bucket(),
        loaded,
        now: NOW,
      });
      const second = await archiveMeasuredObject({
        db,
        bucket: bucket.bucket(),
        loaded,
        now: NOW + 1,
      });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(bucket.putCalls).toBe(2);
      expect(bucket.objects.size).toBe(1);
      const manifest = sqlite.prepare(
        `SELECT verified_at, attempt_count, row_count, dependency_row_count, last_error
           FROM dex_archive_manifests
          WHERE family = 'measured-quote-generation' AND generation_id = ?`,
      ).get(ids.quoteGenerationId) as Record<string, unknown>;
      expect(manifest).toMatchObject({
        verified_at: NOW,
        attempt_count: 2,
        row_count: 70,
        dependency_row_count: 70,
        last_error: null,
      });
      const sourceCounts = sqlite.prepare(
        `SELECT
           (SELECT COUNT(*) FROM dex_measured_execution_quotes WHERE generation_id = ?) AS quotes,
           (SELECT COUNT(*) FROM dex_measured_execution_targets WHERE generation_id = ?) AS targets`,
      ).get(ids.quoteGenerationId, ids.targetGenerationId);
      expect(sourceCounts).toEqual({ quotes: 70, targets: 70 });
    } finally {
      sqlite.close();
    }
  });

  it("excludes current, hot, incomplete, and count-mismatched generations", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const eligible = insertBundle(sqlite, "eligible");
      insertBundle(sqlite, "hot", 2, NOW - 60);
      const current = insertBundle(sqlite, "current");
      sqlite.prepare(
        "UPDATE surface_publication_generations SET state = 'published' WHERE generation_id IN (?, ?)",
      ).run(current.quoteGenerationId, current.targetGenerationId);
      const incomplete = insertBundle(sqlite, "incomplete");
      sqlite.prepare(
        "UPDATE surface_publication_generations SET published_rows = 1 WHERE generation_id = ?",
      ).run(incomplete.quoteGenerationId);
      const mismatch = insertBundle(sqlite, "mismatch");
      sqlite.prepare(
        "DELETE FROM dex_measured_execution_quotes WHERE generation_id = ? AND target_id = 'target-001'",
      ).run(mismatch.quoteGenerationId);

      const candidates = await listMeasuredArchiveCandidates(db, NOW, 12);
      expect(candidates.map((candidate) => candidate.generationId)).toEqual([
        eligible.quoteGenerationId,
        mismatch.quoteGenerationId,
      ]);
      await expect(
        loadMeasuredArchiveArtifact(db, candidates[1]!, NOW),
      ).rejects.toThrow("dependency closure mismatch");
    } finally {
      sqlite.close();
    }
  });

  it("retains D1 and leaves the manifest unverified when downloaded bytes mismatch", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const ids = insertBundle(sqlite, "corrupt");
      const candidate = (await listMeasuredArchiveCandidates(db, NOW, 1))[0]!;
      const loaded = await loadMeasuredArchiveArtifact(db, candidate, NOW);
      const bucket = new MemoryR2();
      bucket.corruptReads = true;
      await expect(
        archiveMeasuredObject({ db, bucket: bucket.bucket(), loaded, now: NOW }),
      ).rejects.toThrow();
      const manifest = sqlite.prepare(
        "SELECT verified_at, last_error FROM dex_archive_manifests WHERE generation_id = ?",
      ).get(ids.quoteGenerationId) as Record<string, unknown>;
      expect(manifest.verified_at).toBeNull();
      expect(manifest.last_error).toBeTruthy();
      expect(
        sqlite.prepare(
          "SELECT COUNT(*) AS count FROM dex_measured_execution_quotes WHERE generation_id = ?",
        ).get(ids.quoteGenerationId),
      ).toEqual({ count: 2 });
    } finally {
      sqlite.close();
    }
  });

  it("processes at most twelve objects and keeps liquidity off", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      for (let index = 0; index < 13; index += 1) {
        insertBundle(sqlite, index.toString().padStart(2, "0"), 1, OLD + index);
      }
      const bucket = new MemoryR2();
      const result = await runDexArchive(
        db,
        bucket.bucket(),
        {
          DEX_MEASURED_ARCHIVE_MODE: "shadow",
          DEX_LIQUIDITY_ARCHIVE_MODE: "off",
        },
        undefined,
        NOW,
      );
      expect(result.status).toBe("ok");
      expect(result.itemCount).toBe(12);
      expect(bucket.objects.size).toBe(12);
      expect(
        sqlite.prepare(
          "SELECT effective_mode FROM dex_archive_family_state WHERE family = 'measured-execution'",
        ).get(),
      ).toEqual({ effective_mode: "shadow" });
      expect(
        sqlite.prepare(
          "SELECT effective_mode FROM dex_archive_family_state WHERE family = 'liquidity'",
        ).get(),
      ).toEqual({ effective_mode: "off" });
      expect(
        sqlite.prepare("SELECT COUNT(*) AS count FROM dex_measured_execution_quotes").get(),
      ).toEqual({ count: 13 });
    } finally {
      sqlite.close();
    }
  });

  it("archives a complete unreferenced target-only generation", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      insertGeneration(sqlite, {
        surface: TARGET_SURFACE,
        generationId: "target-only",
        expectedRows: 1,
      });
      sqlite.prepare(
        `INSERT INTO dex_measured_execution_targets
           (generation_id, target_id, stablecoin_id, adapter_profile_id, protocol,
            chain, pool_id, captured_at, target_json)
         VALUES ('target-only', 'one', 'coin', 'adapter', 'protocol', 'ethereum',
                 'pool', ?, '{"targetId":"one"}')`,
      ).run(OLD);
      const candidates = await listMeasuredArchiveCandidates(db, NOW, 12);
      expect(candidates).toMatchObject([
        {
          kind: "target",
          generationId: "target-only",
          dependencyGenerationId: null,
        },
      ]);
      const loaded = await loadMeasuredArchiveArtifact(db, candidates[0]!, NOW);
      expect(loaded.artifactInput.family).toBe("measured-target-generation");
      expect(loaded.artifactInput.rowCount).toBe(1);
      expect(loaded.artifactInput.dependencyRowCount).toBe(0);
    } finally {
      sqlite.close();
    }
  });

  it("keeps unverified three-day cleanup rows and atomically marks verified source deletion", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      const fourDaysAgo = NOW - 4 * 24 * 60 * 60;
      const ids = insertBundle(sqlite, "cleanup", 2, fourDaysAgo);
      await pruneDexMeasuredExecutionGenerations(db, NOW, undefined, "shadow");
      expect(
        sqlite.prepare(
          "SELECT COUNT(*) AS count FROM dex_measured_execution_quotes WHERE generation_id = ?",
        ).get(ids.quoteGenerationId),
      ).toEqual({ count: 2 });

      const candidate = (await listMeasuredArchiveCandidates(db, NOW, 1))[0]!;
      const loaded = await loadMeasuredArchiveArtifact(db, candidate, NOW);
      await archiveMeasuredObject({
        db,
        bucket: new MemoryR2().bucket(),
        loaded,
        now: NOW,
      });
      await pruneDexMeasuredExecutionGenerations(db, NOW, undefined, "shadow");

      expect(
        sqlite.prepare(
          "SELECT COUNT(*) AS count FROM dex_measured_execution_quotes WHERE generation_id = ?",
        ).get(ids.quoteGenerationId),
      ).toEqual({ count: 0 });
      expect(
        sqlite.prepare(
          "SELECT COUNT(*) AS count FROM dex_measured_execution_targets WHERE generation_id = ?",
        ).get(ids.targetGenerationId),
      ).toEqual({ count: 0 });
      expect(
        sqlite.prepare(
          "SELECT source_deleted_at FROM dex_archive_manifests WHERE generation_id = ?",
        ).get(ids.quoteGenerationId),
      ).toEqual({ source_deleted_at: NOW });
      expect(
        sqlite.prepare(
          `SELECT source_deleted_at
             FROM dex_archive_manifest_dependencies
            WHERE generation_id = ? AND dependency_generation_id = ?`,
        ).get(ids.quoteGenerationId, ids.targetGenerationId),
      ).toEqual({ source_deleted_at: NOW });
    } finally {
      sqlite.close();
    }
  });
});
