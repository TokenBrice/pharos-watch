import { describe, expect, it } from "vitest";
import { mockD1 } from "../../../test-helpers/__shared/mock-d1";
import { encodeResponseReadyCacheValue, getResponseReadyCacheKey } from "../../../lib/api-cache-read";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../../../lib/response-ready-cache-contracts";
import { validateAndWriteStablecoinsCache } from "../cache-publication";

describe("validateAndWriteStablecoinsCache", () => {
  it("keeps canonical stablecoins publication successful when response-ready cache write fails", async () => {
    const syncStartSec = 1_777_000_000;
    const body = JSON.stringify({ peggedAssets: [] });
    const responseReadyBody = encodeResponseReadyCacheValue(body, RESPONSE_READY_CACHE_SCHEMA_IDS.stablecoins);
    const db = mockD1([
      {
        match: "INSERT INTO cache",
        matchBinds: ["stablecoins", body, syncStartSec],
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "INSERT INTO cache",
        matchBinds: [getResponseReadyCacheKey("stablecoins"), responseReadyBody, syncStartSec],
        rows: [],
        throwError: new Error("response-ready write failed"),
      },
    ], { requireMatch: true });

    const result = await validateAndWriteStablecoinsCache({
      assets: [],
      db,
      syncStartSec,
      validationContext: "main",
      returnIfAborted: () => null,
      abortResult: () => ({
        status: "degraded",
        itemCount: 0,
        metadata: "aborted",
      }),
    }, () => ({
      status: "degraded",
      itemCount: 0,
      metadata: "blocked",
    }));

    expect(result).toMatchObject({
      written: true,
      skippedBecauseNewer: false,
      cacheKey: "stablecoins",
      responseReadyCacheError: "Error",
    });
  });
});
