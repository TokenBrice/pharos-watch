import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1, type MockD1Database } from "../../test-helpers/__shared/mock-d1";
import { mockFetch } from "../../test-helpers/__shared/mock-fetch";
import { mockFetchRetry } from "../../test-helpers/cron";

vi.mock("../../lib/fetch-retry", () => mockFetchRetry());

import { syncUsdsStatus } from "../sync-usds-status";

function getCacheInsert(db: MockD1Database): { sql: string; binds: unknown[] } | undefined {
  return db.getHistory().find((entry) => entry.sql.includes("INSERT INTO cache") && entry.binds[0] === "usds-status");
}

describe("syncUsdsStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
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
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      implementationAddress: string;
      freezeCapabilityPresent: boolean;
      freezeActive: boolean;
    };
    expect(metadata.implementationAddress).toBe("0x1923dfee706a8e78157416c29cbccfde7cdf4102");
    expect(metadata.freezeCapabilityPresent).toBe(false);
    expect(metadata.freezeActive).toBe(false);

    const insert = getCacheInsert(db as MockD1Database);
    expect(insert).toBeDefined();
    const cached = JSON.parse(String(insert?.binds[1])) as {
      freezeCapabilityPresent: boolean;
      freezeActive: boolean;
      implementationAddress: string;
      lastChecked: number;
    };
    expect(cached.freezeCapabilityPresent).toBe(false);
    expect(cached.freezeActive).toBe(false);
    expect(cached.implementationAddress).toBe("0x1923dfee706a8e78157416c29cbccfde7cdf4102");
    expect(cached.lastChecked).toBe(Math.floor(Date.now() / 1000));
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
