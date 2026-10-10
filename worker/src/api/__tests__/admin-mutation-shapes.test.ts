import { readJsonResponse } from "../../test-helpers/__shared/auth";
/**
 * Shape contracts for retained admin handlers and migrated operator algorithms.
 *
 * Scope: each handler gets a focused (happy-path 200 shape + bad-input 400)
 * assertion. HTTP authentication for retained handlers is covered globally by
 * `admin-auth-contract.test.ts`; migrated algorithms run in the trusted CLI lane.
 *
 * Skipped: `worker/src/lib/backfill-fx.ts` has no `handle*` HTTP entrypoint; it
 * is utility code (fx series helpers) consumed by other handlers, so there is no
 * request/response shape to assert.
 */
import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { mockFetchRetry } from "../../test-helpers/cron/mock-fetch-retry";

stubCryptoForAuth();

// Stub external services the handlers reach for during exercised paths.
vi.mock("../../lib/fetch-retry", () => mockFetchRetry({
  fetchWithRetry: vi.fn(async () => new Response("{}", { status: 200 })),
}));
vi.mock("../../lib/mint-burn-pipeline/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mint-burn-pipeline/persistence")>();
  return { ...actual, recalcAffectedHours: vi.fn().mockResolvedValue(undefined) };
});

import { handleReclassifyAtomicRoundtripsTrusted } from "../../../scripts/backfills/reclassify-atomic-roundtrips";
import { handleRemediateBlacklistAmountGapsTrusted } from "../remediate-blacklist-amount-gaps";
import { handleBackfillSupplyHistoryTrusted } from "../../../scripts/backfills/backfill-supply-history";

describe("handleReclassifyAtomicRoundtrips shape", () => {
  it("returns 200 with the documented top-level reclassify shape", async () => {
    const db = mockD1([
      { match: "WHERE flow_type = 'standard'", rows: [] },
      { match: "WHERE flow_type = 'atomic_roundtrip'", rows: [] },
    ]);
    const url = makeApiUrl("https://operator.invalid/jobs/reclassify-atomic-roundtrips");

    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url });

    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;
    expect(body).toMatchObject({
      done: expect.any(Boolean),
      since: expect.any(Number),
      stablecoinId: null,
      updated: expect.any(Number),
      toRoundtrip: expect.any(Number),
      toStandard: expect.any(Number),
      hoursRecalculated: expect.any(Number),
      batchSize: expect.any(Number),
    });
  });

  it("returns 400 with { error } for a malformed `since` query param", async () => {
    const db = mockD1([]);
    const url = makeApiUrl("https://operator.invalid/jobs/reclassify-atomic-roundtrips?since=0foo");

    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url });

    const body = (await readJsonResponse(res, 400)) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

describe("handleRemediateBlacklistAmountGaps shape", () => {
  it("returns 200 with the documented dry-run summary shape", async () => {
    const db = mockD1([{ match: "FROM blacklist_events", rows: [] }]);
    const req = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dryRun: true }),
    });

    const res = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl(req.url), request: req });

    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      filters: expect.any(Object),
      candidateCount: expect.any(Number),
      resolutionCounts: expect.any(Object),
      truncated: expect.any(Boolean),
      budgetExhausted: false,
      sample: expect.any(Array),
    });
  });

  it("returns 400 with { error } for a malformed JSON body", async () => {
    const db = mockD1([]);
    const req = makeApiRequest("/api/remediate-blacklist-amount-gaps", {
      method: "POST",
      adminKey: "secret",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });

    const res = await handleRemediateBlacklistAmountGapsTrusted({ db, url: makeApiUrl(req.url), request: req });

    const body = (await readJsonResponse(res, 400)) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

describe("handleBackfillSupplyHistory shape", () => {
  it("returns 200 with the no-targets message shape for an out-of-range batch", async () => {
    const db = mockD1([]);
    const req = makeApiRequest("https://operator.invalid/jobs/backfill-supply-history?batch=999999&batchSize=100", {
      adminKey: "secret",
    });

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });

    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;
    expect(body).toMatchObject({ message: expect.any(String) });
  });

  it("returns 400 with { error } for a malformed startDay query param", async () => {
    const db = mockD1([]);
    const req = makeApiRequest("https://operator.invalid/jobs/backfill-supply-history?startDay=not-a-date", {
      adminKey: "secret",
    });

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });

    const body = (await readJsonResponse(res, 400)) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});
