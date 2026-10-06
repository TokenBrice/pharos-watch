import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleStablecoinReserves, reserveCacheControlForMode } from "../stablecoin-reserves";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";
import type { ReservePresentationMode } from "@shared/types/live-reserves";
import { reserveCompositionRow, reserveSyncRow } from "./stablecoin-reserves.test-support";
import { LIVE_RESERVE_FRESHNESS_SEC } from "../../lib/live-reserves/store-shared";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { WORKER_TRACKED_META_BY_ID, hasWorkerLiveReserves } from "@shared/lib/stablecoins/worker-runtime-registry";
import { getReserves } from "@shared/lib/reserve-templates";

describe("handleStablecoinReserves", () => {
  it("preserves every configured feed's reserve display and admission inputs in the Worker projection", () => {
    for (const coin of TRACKED_STABLECOINS.filter((coin) => coin.liveReservesConfig)) {
      const projected = WORKER_TRACKED_META_BY_ID.get(coin.id);
      expect(projected && hasWorkerLiveReserves(projected), coin.id).toBe(true);
      if (!projected || !hasWorkerLiveReserves(projected)) continue;
      expect(projected.liveReservesConfig, coin.id).toEqual(coin.liveReservesConfig);
      expect(getReserves(projected), coin.id).toEqual(getReserves(coin));
    }
  });

  it("keeps USDAI on the reserve endpoint with the curated stablecoin fallback until a validated snapshot is synced", async () => {
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [] },
      { match: "FROM reserve_sync_state", rows: [] },
    ]);
    const res = await handleStablecoinReserves(db, "usdai-usd-ai");

    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body).toMatchObject({
      mode: "curated-fallback",
      estimated: false,
      displayUrl: "https://usd.ai/usdai",
      reserves: [
        {
          coinId: "pyusd-paypal",
          pct: 100,
          risk: "low",
        },
      ],
      sync: {
        enabled: true,
        bootstrap: true,
      },
    });
  });

  it("returns a curated fallback payload when no live data exists in D1 yet", async () => {
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [] },
      { match: "FROM reserve_sync_state", rows: [] },
    ]);
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.mode).toBe("curated-fallback");
    expect(body.estimated).toBe(false);
    expect(body.displayBadge).toBeUndefined();
    expect(body.sync?.bootstrap).toBe(true);
  });

  it("returns live slices when D1 has data", async () => {
    const now = Math.floor(Date.now() / 1000);
    const slices = [{ name: "Test Farm", pct: 100, risk: "low" as const }];
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: reserveCompositionRow(now, { slices: JSON.stringify(slices), metadata: JSON.stringify({
          freshnessMode: "not-applicable",
          yieldBasisCollateralPct: 89.7,
          redemption: {
            sourceUrls: [
              "https://stats.infinifi.xyz/",
              "https://docs.infinifi.example/reserves",
              "https://docs.infinifi.example/reserves",
            ],
          },
        }) }),
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now),
      },
    ]);
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600, max-age=300");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.reserves).toEqual(slices);
    expect(body.estimated).toBe(false);
    expect(body.source).toBe("infinifi");
    expect(body.mode).toBe("live");
    expect(body.metadata).toEqual({
      freshnessMode: "not-applicable",
      yieldBasisCollateralPct: 89.7,
      redemption: {
        sourceUrls: [
          "https://stats.infinifi.xyz/",
          "https://docs.infinifi.example/reserves",
        ],
      },
    });
    expect(body.evidenceUrls).toEqual(["https://docs.infinifi.example/reserves"]);
    expect(body.displayBadge).toEqual({
      kind: "live",
      label: "Live",
    });
    expect(body.provenance).toEqual({
      evidenceClass: "independent",
      sourceModel: "dynamic-mix",
      freshnessMode: "not-applicable",
      scoringEligible: true,
      scoringRejectionReasons: [],
    });
  });

  it("falls back to curated reserves and fallback cache when stored live slices are corrupt", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: reserveCompositionRow(now, { slices: "not json" }),
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now),
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.mode).toBe("curated-fallback");
    expect(body.provenance).toBeUndefined();
    expect(body.displayBadge).toBeUndefined();
    expect(body.sync).toMatchObject({
      enabled: true,
      status: "degraded",
      bootstrap: false,
      warnings: ["Stored live reserve snapshot is unreadable"],
      lastError: "Stored live reserve snapshot rejected: Stored live reserve snapshot is unreadable",
    });
  });

  it("does not serialize internal malformed redemption telemetry markers", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: reserveCompositionRow(now, { slices: JSON.stringify([{ name: "Test Farm", pct: 100, risk: "low" }]), metadata: JSON.stringify({
          freshnessMode: "not-applicable",
          immediateRedeemableUsd: 500_000,
          redemptionFeeBps: 50,
          redemption: {
            capacityUsd: "500000",
            feeBps: null,
          },
        }) }),
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now),
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("malformedRedemptionTelemetry");
    expect(text).not.toContain("__malformedRedemptionTelemetry");

    const body = StablecoinReservesResponseSchema.parse(JSON.parse(text));
    expect(body.metadata?.redemption).toEqual({});
  });

  registerStablecoinParameterContract({
    name: "stablecoin reserves",
    path: "/api/stablecoin-reserves",
    invoke: (db, url) => handleStablecoinReserves(db, url.searchParams.get("stablecoin") ?? ""),
    cases: [{ kind: "unknown", stablecoin: "not-a-coin", error: "Not found" }],
  });

  it("surfaces lastError from sync state in the API response", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: null,
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now, { last_success_at: null, last_status: "error", last_error: "HTTP 503 for https://api.example.com", metadata: "{}" }),
      },
    ]);
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.sync?.lastError).toBe("HTTP 503 for https://api.example.com");
  });

  it("surfaces uncertain write metadata distinctly in the API response", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: null,
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(now, { last_success_at: null, last_status: "error", last_error: "D1 write timeout for iusd-infinifi", metadata: JSON.stringify({
          uncertainWrite: true,
          failureCategory: "storage-write",
          reason: "storage-write-timeout",
        }) }),
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.sync).toMatchObject({
      status: "error",
      uncertainWrite: true,
      failureCategory: "storage-write",
      lastError: "D1 write timeout for iusd-infinifi",
    });
  });

  it("routes live-stale mode to the intermediate cache-control tier", async () => {
    // Composition fetched_at + sync.last_success_at both well beyond the
    // 2-day freshness window (LIVE_RESERVE_FRESHNESS_SEC) so resolveReserveResult
    // returns mode=live-stale.
    const now = Math.floor(Date.now() / 1000);
    const fetchedAt = now - 3 * 24 * 3600;
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: reserveCompositionRow(fetchedAt, { slices: JSON.stringify([{ name: "Test Farm", pct: 100, risk: "low" }]) }),
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: reserveSyncRow(fetchedAt),
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.mode).toBe("live-stale");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=1800, max-age=120");
    // The route's own fetch budget and the judged generation travel with the verdict.
    const freshness = body.sync?.freshness;
    expect(freshness).toMatchObject({
      stale: true,
      staleReasons: ["fetch-age"],
      fetchedAt,
      attemptId: null,
      fetchBudgetSec: LIVE_RESERVE_FRESHNESS_SEC,
      sourceAgeBudgetSec: null,
    });
    expect(freshness?.fetchAgeSec).toBe(freshness!.assessedAt - fetchedAt);
    expect(freshness!.fetchAgeSec!).toBeGreaterThan(LIVE_RESERVE_FRESHNESS_SEC);
  });


  it.each<[ReservePresentationMode, string]>([
    ["live", "public, s-maxage=3600, max-age=300"],
    ["live-stale", "public, s-maxage=1800, max-age=120"],
    ["curated-fallback", "public, s-maxage=300, max-age=60"],
    ["template-fallback", "public, s-maxage=300, max-age=60"],
    ["unavailable", "public, s-maxage=300, max-age=60"],
  ])("maps mode=%s to the correct Cache-Control tier", (mode, expected) => {
    expect(reserveCacheControlForMode(mode)).toBe(expected);
  });

  it("derates live cache control when the sync is not ok or the write is uncertain", () => {
    expect(reserveCacheControlForMode("live", { enabled: true, status: "ok", stale: false, bootstrap: false }))
      .toBe("public, s-maxage=3600, max-age=300");
    expect(reserveCacheControlForMode("live", { enabled: true, status: "degraded", stale: false, bootstrap: false }))
      .toBe("public, s-maxage=300, max-age=60");
    expect(reserveCacheControlForMode("live", { enabled: true, status: "error", stale: false, bootstrap: false }))
      .toBe("public, s-maxage=300, max-age=60");
    expect(reserveCacheControlForMode("live", { enabled: true, status: "ok", stale: false, bootstrap: false, uncertainWrite: true }))
      .toBe("public, s-maxage=300, max-age=60");
  });
});
