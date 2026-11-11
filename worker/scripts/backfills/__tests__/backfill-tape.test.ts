import { afterEach, describe, it, expect, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { mockD1, type MockD1Database } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, readJsonResponse, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { handleBackfillTape } from "../backfill-tape";
import { TAPE_PROJECTOR_JOBS } from "../../../src/lib/tape-projectors/registry";

stubCryptoForAuth();
const fixtures = createLatestSchemaFixtureTracker();

afterEach(() => {
  vi.restoreAllMocks();
  fixtures.closeAll();
});

function emptyDb(): MockD1Database {
  return mockD1([
    ...[
      "FROM cache WHERE key",
      "ended_at IS NULL",
      "started_at > ?",
      "ended_at IS NOT NULL AND ended_at > ?",
      "ended_at > ? AND source = 'live'",
      "FROM blacklist_events",
      "FROM mint_burn_events",
      "FROM mint_burn_admission",
      "FROM mint_burn_publication_policy",
      "pharos:mint-burn-scan-coverage:read",
      "pharos:mint-burn-legacy-evidence",
      "FROM stress_signals",
      "FROM stability_index_samples",
      "FROM yield_history",
      "FROM yield_source_decisions",
      "FROM safety_score_history_v2",
      "FROM safety_grade_history",
    ].map((match) => ({ match, rows: [] })),
    { match: "SELECT 1 AS observed", rows: [{ observed: 1 }] },
  ]);
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
    const { db, sqlite } = fixtures.open();
    vi.spyOn(Date, "now").mockReturnValue(1730000000000);
    sqlite.exec(`INSERT INTO depeg_events
      (stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, start_price, peg_reference)
      VALUES ('usdt-tether', 'USDT', 'peggedUSD', 'below', -200, 1730000000, 0.98, 1)`);
    for (const dryRun of [true, false]) {
      const url = makeApiUrl(`/api/backfill-tape?class=depeg.opened&dryRun=${dryRun}`);
      const res = await handleBackfillTape({ db, url });
      expect(await readJsonResponse(res, 200)).toMatchObject({ projected: 1 });
      expect(sqlite.prepare("SELECT source_row_id FROM tape_events").all())
        .toEqual(dryRun ? [] : [{ source_row_id: "1" }]);
      expect(sqlite.prepare("SELECT key, value FROM cache").all())
        .toEqual(dryRun ? [] : [{ key: "tape-projector:cursor:depeg.opened", value: "1730000000" }]);
    }
  });
});
