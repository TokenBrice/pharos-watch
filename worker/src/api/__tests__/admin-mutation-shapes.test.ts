import { readJsonResponse } from "../../test-helpers/__shared/auth";
/**
 * Bad-input contracts for retained admin handlers and migrated operator algorithms.
 * HTTP authentication for retained handlers is covered globally by
 * `admin-auth-contract.test.ts`; migrated algorithms run in the trusted CLI lane.
 *
 * Skipped: `worker/src/lib/backfill-fx.ts` has no `handle*` HTTP entrypoint; it
 * is utility code (fx series helpers) consumed by other handlers, so there is no
 * request/response shape to assert.
 */
import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";

stubCryptoForAuth();

import { handleReclassifyAtomicRoundtripsTrusted } from "../../../scripts/backfills/reclassify-atomic-roundtrips";
import { handleBackfillSupplyHistoryTrusted } from "../../../scripts/backfills/backfill-supply-history";

describe("handleReclassifyAtomicRoundtrips shape", () => {
  it("returns 400 with { error } for a malformed `since` query param", async () => {
    const db = mockD1([]);
    const url = makeApiUrl("https://operator.invalid/jobs/reclassify-atomic-roundtrips?since=0foo");

    const res = await handleReclassifyAtomicRoundtripsTrusted({ db, url });

    const body = (await readJsonResponse(res, 400)) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});

describe("handleBackfillSupplyHistory shape", () => {
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
