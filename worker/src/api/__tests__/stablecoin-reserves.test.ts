import { readJsonResponse } from "./api-request-response.test-support";
import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleStablecoinReserves, reserveCacheControlForMode } from "../stablecoin-reserves";
import { StablecoinReservesResponseSchema } from "@shared/types/live-reserves";
import type { ReservePresentationMode } from "@shared/types/live-reserves";

describe("handleStablecoinReserves", () => {
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
          name: "PYUSD held by the canonical USDai contract",
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
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify(slices),
          fetched_at: now,
          source: "infinifi",
          metadata: JSON.stringify({
            freshnessMode: "not-applicable",
            yieldBasisCollateralPct: 89.7,
            redemption: {
              sourceUrls: [
                "https://stats.infinifi.xyz/",
                "https://docs.infinifi.example/reserves",
                "https://docs.infinifi.example/reserves",
              ],
            },
          }),
          adapter_source_model: "dynamic-mix",
          adapter_evidence_class: "independent",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        },
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
    });
  });

  it("falls back to curated reserves and fallback cache when stored live slices are corrupt", async () => {
    const now = Math.floor(Date.now() / 1000);
    const db = mockD1([
      {
        match: "reserve_composition",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: "not json",
          fetched_at: now,
          source: "infinifi",
          metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
          adapter_source_model: "dynamic-mix",
          adapter_evidence_class: "independent",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        },
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
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify([{ name: "Test Farm", pct: 100, risk: "low" }]),
          fetched_at: now,
          source: "infinifi",
          metadata: JSON.stringify({
            freshnessMode: "not-applicable",
            immediateRedeemableUsd: 500_000,
            redemptionFeeBps: 50,
            redemption: {
              capacityUsd: "500000",
              feeBps: null,
            },
          }),
          adapter_source_model: "dynamic-mix",
          adapter_evidence_class: "independent",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: now,
          last_success_at: now,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        },
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
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: now,
          last_success_at: null,
          last_status: "error",
          warning_count: 0,
          warnings: null,
          last_error: "HTTP 503 for https://api.example.com",
          metadata: "{}",
        },
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
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: now,
          last_success_at: null,
          last_status: "error",
          warning_count: 0,
          warnings: null,
          last_error: "D1 write timeout for iusd-infinifi",
          metadata: JSON.stringify({
            uncertainWrite: true,
            failureCategory: "storage-write",
            reason: "storage-write-timeout",
          }),
        },
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
        first: {
          stablecoin_id: "iusd-infinifi",
          slices: JSON.stringify([{ name: "Test Farm", pct: 100, risk: "low" }]),
          fetched_at: fetchedAt,
          source: "infinifi",
          metadata: JSON.stringify({ freshnessMode: "not-applicable" }),
          adapter_source_model: "dynamic-mix",
          adapter_evidence_class: "independent",
        },
      },
      {
        match: "reserve_sync_state",
        rows: [],
        first: {
          stablecoin_id: "iusd-infinifi",
          adapter_key: "infinifi",
          breaker_key: "live-reserves:infinifi",
          last_attempted_at: fetchedAt,
          last_success_at: fetchedAt,
          last_status: "ok",
          warning_count: 0,
          warnings: null,
          last_error: null,
          metadata: "{}",
        },
      },
    ]);

    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.mode).toBe("live-stale");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=1800, max-age=120");
  });

  it("keeps curated-fallback mode on the short fallback cache-control tier", async () => {
    // Existing behaviour: no live snapshot + curated reserves present -> curated-fallback.
    const db = mockD1([
      { match: "FROM reserve_composition", rows: [] },
      { match: "FROM reserve_sync_state", rows: [] },
    ]);
    const res = await handleStablecoinReserves(db, "usdai-usd-ai");
    const body = StablecoinReservesResponseSchema.parse(await readJsonResponse(res, 200));
    expect(body.mode).toBe("curated-fallback");
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
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
});
