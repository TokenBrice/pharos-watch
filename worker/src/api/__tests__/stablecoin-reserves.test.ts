import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleStablecoinReserves } from "../stablecoin-reserves";

describe("handleStablecoinReserves", () => {
  it("returns a curated fallback payload when no live data exists in D1 yet", async () => {
    const db = mockD1();
    const res = await handleStablecoinReserves(db, "iusd-infinifi");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300, max-age=60");
    const body = (await res.json()) as { mode: string; estimated: boolean; sync?: { bootstrap?: boolean } };
    expect(body.mode).toBe("curated-fallback");
    expect(body.estimated).toBe(false);
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
          metadata: JSON.stringify({ freshnessMode: "not-applicable", yieldBasisCollateralPct: 89.7 }),
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
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=3600, max-age=300");
    const body = (await res.json()) as {
      reserves: unknown[];
      estimated: boolean;
      source: string;
      mode: string;
      metadata?: {
        freshnessMode?: string;
        yieldBasisCollateralPct?: number;
      };
      provenance?: {
        evidenceClass: string;
        sourceModel: string;
        freshnessMode?: string;
        scoringEligible: boolean;
      };
    };
    expect(body.reserves).toEqual(slices);
    expect(body.estimated).toBe(false);
    expect(body.source).toBe("infinifi");
    expect(body.mode).toBe("live");
    expect(body.metadata).toEqual({
      freshnessMode: "not-applicable",
      yieldBasisCollateralPct: 89.7,
    });
    expect(body.provenance).toEqual({
      evidenceClass: "independent",
      sourceModel: "dynamic-mix",
      freshnessMode: "not-applicable",
      scoringEligible: true,
    });
  });

  it("returns 404 for unknown stablecoin IDs", async () => {
    const db = mockD1();
    const res = await handleStablecoinReserves(db, "not-a-coin");
    expect(res.status).toBe(404);
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sync?: { lastError?: string } };
    expect(body.sync?.lastError).toBe("HTTP 503 for https://api.example.com");
  });
});
