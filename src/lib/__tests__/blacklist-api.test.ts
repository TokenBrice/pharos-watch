import { afterEach, describe, expect, it, vi } from "vitest";
import { BLACKLIST_API_PAGE_SIZE, fetchAllBlacklistEvents } from "../blacklist-api";
import type { BlacklistEvent, BlacklistResponse } from "@shared/types";

function makeEvent(id: number): BlacklistEvent {
  const hex = id.toString(16).padStart(64, "0");
  const addressHex = id.toString(16).padStart(40, "0");

  return {
    id: `ethereum-0x${hex}-${id}`,
    stablecoin: "USDT",
    chainId: "ethereum",
    chainName: "Ethereum",
    eventType: "blacklist",
    address: `0x${addressHex}`,
    amount: id + 1,
    txHash: `0x${hex}`,
    blockNumber: 20_000_000 - id,
    timestamp: 1_772_838_315 - id,
    methodologyVersion: "3.1",
    explorerTxUrl: `https://etherscan.io/tx/0x${hex}`,
    explorerAddressUrl: `https://etherscan.io/address/0x${addressHex}`,
  };
}

function jsonResponse(body: BlacklistResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchAllBlacklistEvents", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns the first page when the response already contains the full dataset", async () => {
    const body: BlacklistResponse = {
      events: [makeEvent(1)],
      total: 1,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));

    const result = await fetchAllBlacklistEvents();

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/api/blacklist?limit=${BLACKLIST_API_PAGE_SIZE}`);
  });

  it("hydrates additional pages when the API total exceeds the page cap", async () => {
    const firstPageEvents = Array.from({ length: BLACKLIST_API_PAGE_SIZE }, (_, index) => makeEvent(index));
    const body1: BlacklistResponse = {
      events: firstPageEvents,
      total: BLACKLIST_API_PAGE_SIZE + 2,
    };
    const body2: BlacklistResponse = {
      events: [makeEvent(BLACKLIST_API_PAGE_SIZE), makeEvent(BLACKLIST_API_PAGE_SIZE + 1)],
      total: BLACKLIST_API_PAGE_SIZE + 2,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(body1))
      .mockResolvedValueOnce(jsonResponse(body2));

    const result = await fetchAllBlacklistEvents();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`offset=${BLACKLIST_API_PAGE_SIZE}`);
    expect(result.events).toHaveLength(BLACKLIST_API_PAGE_SIZE + 2);
    expect(result.events[0]?.id).toBe(firstPageEvents[0]?.id);
    expect(result.events.at(-1)?.id).toBe(
      `ethereum-0x${(BLACKLIST_API_PAGE_SIZE + 1).toString(16).padStart(64, "0")}-${BLACKLIST_API_PAGE_SIZE + 1}`,
    );
  });

  it("deduplicates overlapping rows across paginated responses", async () => {
    const firstPageEvents = Array.from({ length: BLACKLIST_API_PAGE_SIZE }, (_, index) => makeEvent(index));
    const body1: BlacklistResponse = {
      events: firstPageEvents,
      total: BLACKLIST_API_PAGE_SIZE + 1,
    };
    const overlapping = makeEvent(BLACKLIST_API_PAGE_SIZE - 1);
    const newEvent = makeEvent(BLACKLIST_API_PAGE_SIZE);
    const body2: BlacklistResponse = {
      events: [overlapping, newEvent],
      total: BLACKLIST_API_PAGE_SIZE + 1,
    };

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body1)).mockResolvedValueOnce(jsonResponse(body2));

    const result = await fetchAllBlacklistEvents();

    expect(result.events).toHaveLength(BLACKLIST_API_PAGE_SIZE + 1);
    expect(result.events.filter((event) => event.id === overlapping.id)).toHaveLength(1);
  });

  it("retries transient 429 responses for follow-up pages", async () => {
    vi.useFakeTimers();

    const firstPageEvents = Array.from({ length: BLACKLIST_API_PAGE_SIZE }, (_, index) => makeEvent(index));
    const body1: BlacklistResponse = {
      events: firstPageEvents,
      total: BLACKLIST_API_PAGE_SIZE + 2,
    };
    const body2: BlacklistResponse = {
      events: [makeEvent(BLACKLIST_API_PAGE_SIZE), makeEvent(BLACKLIST_API_PAGE_SIZE + 1)],
      total: BLACKLIST_API_PAGE_SIZE + 2,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(body1))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(body2));

    const resultPromise = fetchAllBlacklistEvents();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.events).toHaveLength(BLACKLIST_API_PAGE_SIZE + 2);
  });

  it("hydrates remaining pages in small batches instead of one large burst", async () => {
    const firstPageEvents = Array.from({ length: BLACKLIST_API_PAGE_SIZE }, (_, index) => makeEvent(index));
    const firstPage: BlacklistResponse = {
      events: firstPageEvents,
      total: BLACKLIST_API_PAGE_SIZE * 5,
    };

    const pageBodies = new Map<number, BlacklistResponse>([
      [BLACKLIST_API_PAGE_SIZE, { events: [makeEvent(BLACKLIST_API_PAGE_SIZE)], total: firstPage.total }],
      [BLACKLIST_API_PAGE_SIZE * 2, { events: [makeEvent(BLACKLIST_API_PAGE_SIZE * 2)], total: firstPage.total }],
      [BLACKLIST_API_PAGE_SIZE * 3, { events: [makeEvent(BLACKLIST_API_PAGE_SIZE * 3)], total: firstPage.total }],
      [BLACKLIST_API_PAGE_SIZE * 4, { events: [makeEvent(BLACKLIST_API_PAGE_SIZE * 4)], total: firstPage.total }],
    ]);

    let activeRequests = 0;
    let maxConcurrentRequests = 0;
    const pendingResolvers = new Map<number, () => void>();

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = new URL(String(input), "https://pharos.watch");
      const offset = Number(url.searchParams.get("offset") ?? "0");
      if (offset === 0) {
        return Promise.resolve(jsonResponse(firstPage));
      }

      activeRequests += 1;
      maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);

      return new Promise<Response>((resolve) => {
        pendingResolvers.set(offset, () => {
          activeRequests -= 1;
          resolve(jsonResponse(pageBodies.get(offset)!));
        });
      });
    });

    const resultPromise = fetchAllBlacklistEvents();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(maxConcurrentRequests).toBe(3);
    expect(pendingResolvers.has(BLACKLIST_API_PAGE_SIZE * 4)).toBe(false);

    pendingResolvers.get(BLACKLIST_API_PAGE_SIZE)?.();
    pendingResolvers.get(BLACKLIST_API_PAGE_SIZE * 2)?.();
    pendingResolvers.get(BLACKLIST_API_PAGE_SIZE * 3)?.();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(pendingResolvers.has(BLACKLIST_API_PAGE_SIZE * 4)).toBe(true);
    expect(maxConcurrentRequests).toBe(3);

    pendingResolvers.get(BLACKLIST_API_PAGE_SIZE * 4)?.();

    const result = await resultPromise;
    expect(result.events).toHaveLength(BLACKLIST_API_PAGE_SIZE + 4);
  });
});
