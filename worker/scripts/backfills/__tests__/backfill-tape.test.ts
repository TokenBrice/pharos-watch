import { readJsonResponse } from "../../../src/test-helpers/__shared/auth";
import { afterEach, describe, it, expect, vi } from "vitest";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { handleBackfillTape } from "../backfill-tape";
import { TAPE_PROJECTOR_JOBS } from "../../../src/lib/tape-projectors/registry";

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
    { match: "ended_at > ? AND source = 'live'", rows: [] },
    { match: "FROM blacklist_events", rows: [] },
    { match: "FROM mint_burn_events", rows: [] },
    { match: "FROM stress_signals", rows: [] },
    { match: "FROM stability_index_samples", rows: [] },
    { match: "FROM yield_history", rows: [] },
    { match: "FROM yield_source_decisions", rows: [] },
    { match: "FROM safety_score_history_v2", rows: [] },
    { match: "FROM safety_grade_history", rows: [] },
    // First-observation projectors probe each source key; return an observed
    // marker regardless of the key so this suite exercises dispatch only.
    { match: "SELECT 1 AS observed", rows: [{ observed: 1 }] },
  ]) as MockD1Database;
}

describe("handleBackfillTape", () => {
  it("honors query window and cap over conflicting JSON body integers", async () => {
    const job = TAPE_PROJECTOR_JOBS[0]!;
    const run = vi.spyOn(job, "run").mockResolvedValue({ projected: 0, advanced: null });
    const path = `/api/backfill-tape?class=${job.name}&since=200&until=300&maxRows=1`;
    const res = await handleBackfillTape({
      db: emptyDb(), url: makeApiUrl(path),
      request: new Request(makeApiUrl(path), { method: "POST", body: JSON.stringify({ since: 100, until: 400, maxRows: 5000 }) }),
    });
    expect(await readJsonResponse(res, 200)).toMatchObject({ since: 200, until: 300, maxRows: 1 });
    expect(run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ since: 200, until: 300, maxRows: 1 }));
  });

  it("rejects an over-budget maxRows with 400", async () => {
    const res = await handleBackfillTape({ db: emptyDb(), url: makeApiUrl("/api/backfill-tape?maxRows=999999"), trustedAdmin: true, request: makeApiRequest("/api/backfill-tape?maxRows=999999", { method: "POST", adminKey: "secret" }) });
    expect(res.status).toBe(400);
  });

  it("filters the run to the explicit class list", async () => {
    const res = await handleBackfillTape({ db: emptyDb(), url: makeApiUrl("/api/backfill-tape?class=depeg.opened&class=score.upgraded&dryRun=true"), trustedAdmin: true, request: makeApiRequest("/api/backfill-tape?class=depeg.opened&class=score.upgraded&dryRun=true", {
        method: "POST",
        adminKey: "secret",
      }) });
    const body = (await readJsonResponse(res, 200)) as { selectedClasses: string[] };
    expect(body.selectedClasses).toEqual(["depeg.opened", "score.upgraded"]);
  });

  it("returns a non-success status when a selected projector fails", async () => {
    const job = TAPE_PROJECTOR_JOBS[0]!;
    vi.spyOn(job, "run").mockRejectedValueOnce(new Error("projector unavailable"));
    const path = `/api/backfill-tape?class=${encodeURIComponent(job.name)}&dryRun=true`;

    const res = await handleBackfillTape({ db: emptyDb(), url: makeApiUrl(path), trustedAdmin: true, request: makeApiRequest(path, { method: "POST", adminKey: "secret" }) });
    const body = (await readJsonResponse(res, 500)) as {
      ok: boolean;
      errors: Array<{ name: string; message: string }>;
      projected: number;
    };

    expect(body.ok).toBe(false);
    expect(body.projected).toBe(0);
    expect(body.errors).toEqual([{ name: job.name, message: "projector unavailable" }]);
  });

  it("does not write inserts when dryRun=true", async () => {
    const db = emptyDb();
    const res = await handleBackfillTape({ db, url: makeApiUrl("/api/backfill-tape?dryRun=true"), trustedAdmin: true, request: makeApiRequest("/api/backfill-tape?dryRun=true", { method: "POST", adminKey: "secret" }) });
    expect(res.status).toBe(200);
    const inserts = db.getHistory().filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"));
    expect(inserts).toHaveLength(0);
  });
});
