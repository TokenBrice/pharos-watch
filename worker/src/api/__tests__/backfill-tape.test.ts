import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { handleBackfillTape } from "../backfill-tape";
import { TAPE_PROJECTOR_JOBS } from "../../cron/project-tape";

stubCryptoForAuth();

afterEach(() => {
  vi.restoreAllMocks();
});

function emptyDb(): MockD1Database {
  // Provide rows for every read the projectors might attempt; an empty result
  // is fine — we are testing the admin contract and dispatch, not projection.
  return mockD1([
    { match: "FROM cache WHERE key", rows: [] },
    { match: "ended_at IS NULL", rows: [] },
    { match: "started_at > ?", rows: [] },
    { match: "ended_at IS NOT NULL AND ended_at > ?", rows: [] },
    { match: "FROM blacklist_events", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    // first-observation projectors look at tape_events; mark every entry as
    // already-emitted by handing back a wildcard row per query.
    { match: "SELECT source_row_id FROM tape_events", rows: [{ source_row_id: "*" }] },
  ]) as MockD1Database;
}

describe("handleBackfillTape", () => {
  it("requires admin auth", async () => {
    const res = await handleBackfillTape(
      emptyDb(),
      makeApiUrl("/api/backfill-tape"),
      undefined,
      makeApiRequest("/api/backfill-tape", { method: "POST" }),
    );
    // Admin auth rejects with 401/403 depending on the trustedAdmin signal
    // wiring; mirror the other backfill tests by accepting either.
    expect([401, 403]).toContain(res.status);
  });

  it("rejects unknown class names with 400", async () => {
    const res = await handleBackfillTape(
      emptyDb(),
      makeApiUrl("/api/backfill-tape?class=does.not.exist"),
      true,
      makeApiRequest("/api/backfill-tape?class=does.not.exist", { method: "POST", adminKey: "secret" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown class");
  });

  it("rejects an inverted since/until window with 400", async () => {
    const res = await handleBackfillTape(
      emptyDb(),
      makeApiUrl("/api/backfill-tape?since=200&until=100"),
      true,
      makeApiRequest("/api/backfill-tape?since=200&until=100", { method: "POST", adminKey: "secret" }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects an over-budget maxRows with 400", async () => {
    const res = await handleBackfillTape(
      emptyDb(),
      makeApiUrl("/api/backfill-tape?maxRows=999999"),
      true,
      makeApiRequest("/api/backfill-tape?maxRows=999999", { method: "POST", adminKey: "secret" }),
    );
    expect(res.status).toBe(400);
  });

  it("returns ok=true with per-class counts in dryRun mode", async () => {
    const res = await handleBackfillTape(
      emptyDb(),
      makeApiUrl("/api/backfill-tape?dryRun=true"),
      true,
      makeApiRequest("/api/backfill-tape?dryRun=true", { method: "POST", adminKey: "secret" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      dryRun: boolean;
      perClass: Record<string, number>;
      selectedClasses: string[];
      projected: number;
    };
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.selectedClasses).toEqual(TAPE_PROJECTOR_JOBS.map((job) => job.name));
    expect(body.perClass).toHaveProperty("depeg.opened");
    expect(body.perClass).toHaveProperty("methodology.bumped");
    expect(body.perClass).toHaveProperty("cemetery.entry.added");
    // Watermark-driven classes are quiet on the empty mock; first-observation
    // classes report what they would emit (counted but not written under dryRun).
    expect(body.perClass["depeg.opened"]).toBe(0);
    expect(body.perClass["freeze.blocked"]).toBe(0);
    expect(body.perClass["score.upgraded"]).toBe(0);
    expect(body.projected).toBeGreaterThanOrEqual(0);
  });

  it("filters the run to the explicit class list", async () => {
    const res = await handleBackfillTape(
      emptyDb(),
      makeApiUrl("/api/backfill-tape?class=depeg.opened&class=score.upgraded&dryRun=true"),
      true,
      makeApiRequest("/api/backfill-tape?class=depeg.opened&class=score.upgraded&dryRun=true", {
        method: "POST",
        adminKey: "secret",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { selectedClasses: string[] };
    expect(body.selectedClasses).toEqual(["depeg.opened", "score.upgraded"]);
  });

  it("returns a non-success status when a selected projector fails", async () => {
    const job = TAPE_PROJECTOR_JOBS[0]!;
    vi.spyOn(job, "run").mockRejectedValueOnce(new Error("projector unavailable"));
    const path = `/api/backfill-tape?class=${encodeURIComponent(job.name)}&dryRun=true`;

    const res = await handleBackfillTape(
      emptyDb(),
      makeApiUrl(path),
      true,
      makeApiRequest(path, { method: "POST", adminKey: "secret" }),
    );
    const body = (await res.json()) as {
      ok: boolean;
      errors: Array<{ name: string; message: string }>;
      projected: number;
    };

    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.projected).toBe(0);
    expect(body.errors).toEqual([{ name: job.name, message: "projector unavailable" }]);
  });

  it("does not write inserts when dryRun=true", async () => {
    const db = emptyDb();
    const res = await handleBackfillTape(
      db,
      makeApiUrl("/api/backfill-tape?dryRun=true"),
      true,
      makeApiRequest("/api/backfill-tape?dryRun=true", { method: "POST", adminKey: "secret" }),
    );
    expect(res.status).toBe(200);
    const inserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"));
    expect(inserts).toHaveLength(0);
  });
});
