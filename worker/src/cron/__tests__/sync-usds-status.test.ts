import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockD1Preset, findD1HistoryEntry, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";
import * as circuitBreaker from "../../lib/circuit-breaker";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { syncUsdsStatus } from "../sync-usds-status";

const DEFAULT_USDS_D1_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "INSERT INTO cache", rows: [] },
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
];

const mockD1 = createMockD1Preset(DEFAULT_USDS_D1_TABLES);

const getCacheInsert = (db: MockD1Database) => findD1HistoryEntry(db, "INSERT INTO cache", [0, "usds-status"]);

describe("syncUsdsStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("writes USDS status cache on happy path", async () => {
    mockFetch([
      {
        match: "action=eth_getStorageAt",
        body: {
          result: "0x0000000000000000000000001923dfee706a8e78157416c29cbccfde7cdf4102",
        },
      },
    ]);

    const db = mockD1();
    const result = await syncUsdsStatus(db, "etherscan-key");

    expect(result.status).toBeUndefined();
    expect(result.itemCount).toBe(1);
    expect(result.metadata).toBe(
      `{"implementationAddress":"0x1923dfee706a8e78157416c29cbccfde7cdf4102","freezeCapabilityPresent":false,"cacheKey":"usds-status","syncStartSec":${Math.floor(Date.now() / 1000)},"cacheWriteMode":"published","casSkipped":false}`,
    );

    const insert = getCacheInsert(db as MockD1Database);
    expect(insert).toBeDefined();
    const cached = JSON.parse(String(insert?.binds[1])) as {
      freezeCapabilityPresent: boolean;
      implementationAddress: string;
      lastChecked: number;
    };
    expect(cached.freezeCapabilityPresent).toBe(false);
    expect(cached.implementationAddress).toBe("0x1923dfee706a8e78157416c29cbccfde7cdf4102");
    expect(cached.lastChecked).toBe(Math.floor(Date.now() / 1000));
  });

  it.each(["0".repeat(64), `${"0".repeat(63)}1`])("publishes freeze capability for valid probe word %s", async (word) => {
    mockFetch([
      { match: "action=eth_getStorageAt", body: { result: `0x${"0".repeat(24)}${"a".repeat(40)}` } },
      { match: "action=eth_call", body: { result: `0x${word}` } },
    ]);
    const db = mockD1();
    const result = await syncUsdsStatus(db, "etherscan-key");
    expect(result.itemCount).toBe(1);
    const insert = getCacheInsert(db);
    expect(insert).toBeDefined();
    expect(JSON.parse(String(insert!.binds[1]))).toMatchObject({
      freezeCapabilityPresent: true,
      implementationAddress: `0x${"a".repeat(40)}`,
    });
  });

  it("skips fresh cached status without network or publication", async () => {
    const fetch = mockFetch([]);
    const db = mockD1([{ match: "SELECT value, updated_at FROM cache WHERE key = ?", first: { value: "{}", updated_at: Math.floor(Date.now() / 1000) }, rows: [] }]);
    const result = await syncUsdsStatus(db, "etherscan-key");
    expect(JSON.parse(result.metadata!)).toMatchObject({ reason: "cache-fresh" });
    expect(fetch).not.toHaveBeenCalled();
    expect(getCacheInsert(db)).toBeUndefined();
  });

  it("skips an open Etherscan circuit without network or publication", async () => {
    vi.spyOn(circuitBreaker, "shouldAttemptFetch").mockResolvedValue(false);
    const fetch = mockFetch([]);
    const db = mockD1();
    const result = await syncUsdsStatus(db, "etherscan-key");
    expect(result).toMatchObject({ status: "degraded", itemCount: 0 });
    expect(JSON.parse(result.metadata!)).toMatchObject({ reason: "etherscan-circuit-open" });
    expect(fetch).not.toHaveBeenCalled();
    expect(getCacheInsert(db)).toBeUndefined();
  });

  it("reports CAS loss without classifying the provider as failed", async () => {
    const outcome = vi.spyOn(circuitBreaker, "recordOutcomeSafe");
    mockFetch([{ match: "action=eth_getStorageAt", body: { result: "0x0000000000000000000000001923dfee706a8e78157416c29cbccfde7cdf4102" } }]);
    const db = mockD1([{ match: "INSERT INTO cache", rows: [], runMeta: { changes: 0 } }]);
    const result = await syncUsdsStatus(db, "etherscan-key");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata!)).toMatchObject({ cacheWriteMode: "skipped-newer", casSkipped: true });
    expect(outcome).toHaveBeenCalledWith(db, "etherscan", true);
    expect(outcome).not.toHaveBeenCalledWith(db, "etherscan", false);
  });

  it("returns degraded when upstream probe call fails", async () => {
    mockFetch([
      {
        match: "action=eth_getStorageAt",
        body: {
          result: "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      {
        match: "action=eth_call",
        body: { error: "upstream timeout" },
        status: 500,
      },
    ]);

    const db = mockD1();
    const result = await syncUsdsStatus(db, "etherscan-key");

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string;
      implementationAddress: string;
    };
    expect(metadata.reason).toBe("freeze-probe-failed");
    expect(metadata.implementationAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
  });

  it("returns degraded when the upstream probe payload is malformed", async () => {
    mockFetch([
      {
        match: "action=eth_getStorageAt",
        body: {
          result: "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
      {
        match: "action=eth_call",
        body: { result: "0x01" },
      },
    ]);

    const db = mockD1();
    const result = await syncUsdsStatus(db, "etherscan-key");

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string;
      implementationAddress: string;
    };
    expect(metadata.reason).toBe("freeze-probe-failed");
    expect(metadata.implementationAddress).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
  });

  it("returns degraded on invalid implementation-slot payload", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockFetch([
      {
        match: "action=eth_getStorageAt",
        body: { result: "0x" },
      },
    ]);

    const db = mockD1();
    const result = await syncUsdsStatus(db, "etherscan-key");

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string };
    expect(metadata.reason).toBe("implementation-slot-unavailable");
    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      event: "implementation-slot-unavailable",
      job: "sync-usds-status",
      level: "warn",
      message: "Failed to read implementation slot",
    });
    expect(getCacheInsert(db as MockD1Database)).toBeUndefined();
  });

  it("returns degraded when the cache write fails after a successful probe", async () => {
    mockFetch([
      {
        match: "action=eth_getStorageAt",
        body: {
          result: "0x0000000000000000000000001923dfee706a8e78157416c29cbccfde7cdf4102",
        },
      },
    ]);

    const db = mockD1([
      {
        match: "INSERT INTO cache",
        rows: [],
        throwError: new Error("cache down"),
      },
    ]);
    const result = await syncUsdsStatus(db, "etherscan-key");

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { reason: string };
    expect(metadata.reason).toBe("cache-write-failed");
  });
});
