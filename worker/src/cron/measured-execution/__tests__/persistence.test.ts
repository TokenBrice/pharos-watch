import { describe, expect, it, vi } from "vitest";

import {
  publishDexMeasuredQuoteGeneration,
  publishDexMeasuredTargetInventory,
  pruneDexMeasuredExecutionGenerations,
} from "../persistence";

describe("measured execution publication", () => {
  it("rejects an empty target generation before touching the publication pointer", async () => {
    const prepare = vi.fn();

    await expect(
      publishDexMeasuredTargetInventory({
        db: { prepare } as Pick<D1Database, "prepare"> as D1Database,
        targets: [],
        capturedAt: 1_700_000_000,
      }),
    ).rejects.toThrow("empty measured target generation");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects an empty quote generation before touching the publication pointer", async () => {
    const prepare = vi.fn();

    await expect(
      publishDexMeasuredQuoteGeneration({
        db: { prepare } as Pick<D1Database, "prepare"> as D1Database,
        targetGeneration: { generationId: "targets", targets: [], publishedAt: 1_700_000_000 },
        outcomes: [],
        quotedAt: 1_700_000_100,
      }),
    ).rejects.toThrow("empty measured quote generation");
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("measured execution generation prune", () => {
  it("deletes only terminal generations past the 3-day horizon in bounded oldest-first batches", async () => {
    const batched: Array<{ sql: string; binds: unknown[] }> = [];
    const db = {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({ sql, binds }),
      }),
      batch: async (stmts: Array<{ sql: string; binds: unknown[] }>) => {
        batched.push(...stmts);
        return stmts.map(() => ({ meta: { changes: 0 } }));
      },
    } as unknown as D1Database;

    const nowSec = 1_700_000_000;
    await pruneDexMeasuredExecutionGenerations(db, nowSec);

    expect(batched).toHaveLength(3);
    const cutoff = nowSec - 3 * 24 * 60 * 60;
    const [quotes, targets, ledger] = batched;

    expect(quotes.sql).toContain("DELETE FROM dex_measured_execution_quotes");
    expect(quotes.sql).toContain("state IN ('failed', 'rejected', 'superseded')");
    expect(quotes.sql).toContain("ORDER BY started_at ASC LIMIT ?");
    expect(quotes.binds).toEqual(["dex-measured-execution-quotes", cutoff, 16]);

    expect(targets.sql).toContain("DELETE FROM dex_measured_execution_targets");
    expect(targets.sql).toContain(
      "NOT IN (SELECT DISTINCT target_generation_id FROM dex_measured_execution_quotes)",
    );
    expect(targets.sql).toContain("ORDER BY started_at ASC LIMIT ?");
    expect(targets.binds).toEqual(["dex-measured-execution-targets", cutoff, 16]);

    expect(ledger.sql).toContain("DELETE FROM surface_publication_generations");
    expect(ledger.sql).toContain("state IN ('failed', 'rejected', 'superseded')");
    expect(ledger.sql).toContain("q.target_generation_id = surface_publication_generations.generation_id");
    expect(ledger.sql).toContain("FROM dex_measured_execution_targets t");
    expect(ledger.binds).toEqual(["dex-measured-execution-targets", "dex-measured-execution-quotes", cutoff]);
  });
});
