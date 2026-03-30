import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleTreasuryStableExposure } from "../treasury-stable-exposure";

function makeCacheDb(value: unknown, updatedAt: number) {
  const jsonValue = typeof value === "string" ? value : JSON.stringify(value);
  return mockD1([
    {
      match: "cache",
      rows: [{ key: "treasury-stable-exposure", value: jsonValue, updated_at: updatedAt }],
      first: { key: "treasury-stable-exposure", value: jsonValue, updated_at: updatedAt },
    },
  ]);
}

describe("handleTreasuryStableExposure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-30T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an empty 200 payload when cache is empty", async () => {
    const res = await handleTreasuryStableExposure(mockD1());
    expect(res.status).toBe(200);
    const body = await res.json() as {
      entities: unknown[];
      updatedAt: number;
      _meta: { status: string };
      coverage: { entityCount: number; registryCount: number };
    };
    expect(body.entities).toEqual([]);
    expect(body.updatedAt).toBe(0);
    expect(body.coverage.entityCount).toBe(0);
    expect(body.coverage.registryCount).toBeGreaterThan(0);
    expect(body._meta.status).toBe("stale");
  });

  it("returns 200 with freshness metadata for a valid cached payload", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const updatedAt = nowSec - 120;
    const res = await handleTreasuryStableExposure(makeCacheDb({
      entities: [],
      updatedAt,
      coverage: {
        entityCount: 0,
        registryCount: 1,
        launchEligibleCount: 1,
        ownerChainTuples: 2,
        launchOwnerChainTuples: 2,
        evmOnly: true,
        extractionModes: {
          staticSeeded: 1,
          customReviewed: 0,
          dynamicUnresolved: 0,
          missing: 0,
        },
      },
    }, updatedAt));

    expect(res.status).toBe(200);
    const body = await res.json() as { _meta: { ageSeconds: number; status: string } };
    expect(body._meta.ageSeconds).toBe(120);
    expect(body._meta.status).toBe("fresh");
  });

  it("returns 503 when the cached payload is malformed", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await handleTreasuryStableExposure(makeCacheDb({
      entities: [],
      updatedAt: nowSec,
    }, nowSec));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Cached treasury-stable-exposure payload is malformed",
    });
  });
});
