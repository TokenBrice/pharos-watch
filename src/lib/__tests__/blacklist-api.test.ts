import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchBlacklistEvents, fetchBlacklistSummary } from "../blacklist-api";
import type { BlacklistEvent, BlacklistResponse, BlacklistSummaryResponse } from "@shared/types";

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
    amountNative: id + 1,
    amountUsdAtEvent: id + 1,
    amountSource: "historical_balance",
    amountStatus: "resolved",
    txHash: `0x${hex}`,
    blockNumber: 20_000_000 - id,
    timestamp: 1_772_838_315 - id,
    methodologyVersion: "3.2",
    contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
    configKey: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
    eventSignature: "AddedBlackList(address)",
    eventTopic0: "0x42e160154868087d6bfdc0ca23d96a1c1cfa32f1b72ba9ba27b69b98a0d819dc",
    explorerTxUrl: `https://etherscan.io/tx/0x${hex}`,
    explorerAddressUrl: `https://etherscan.io/address/0x${addressHex}`,
  };
}

function jsonResponse(body: BlacklistResponse | BlacklistSummaryResponse): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("blacklist-api", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetchBlacklistEvents forwards pagination, filter, search, and sort params", async () => {
    const body: BlacklistResponse = {
      events: [makeEvent(1)],
      total: 1,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));

    const result = await fetchBlacklistEvents({
      stablecoin: "USDT",
      chainName: "Ethereum",
      eventType: "blacklist",
      query: "0xabc",
      sortBy: "chain",
      sortDirection: "asc",
      limit: 50,
      offset: 100,
    });

    expect(result).toEqual(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/blacklist?");
    expect(url).toContain("stablecoin=USDT");
    expect(url).toContain("chain=Ethereum");
    expect(url).toContain("eventType=blacklist");
    expect(url).toContain("q=0xabc");
    expect(url).toContain("sortBy=chain");
    expect(url).toContain("sortDirection=asc");
    expect(url).toContain("limit=50");
    expect(url).toContain("offset=100");
  });

  it("fetchBlacklistSummary hits the dedicated summary endpoint", async () => {
    const body: BlacklistSummaryResponse = {
      stats: {
        usdcBlacklisted: 1,
        usdtBlacklisted: 2,
        goldBlacklisted: 0,
        frozenAddresses: 3,
        destroyedTotal: 1_000,
        activeAddressCount: 3,
        activeFrozenTotal: 10_000,
        activeAmountGapCount: 0,
        trackedAddressCount: 3,
        trackedFrozenTotal: 10_000,
        trackedAmountGapCount: 0,
        recentCount: 4,
        recentCount24h: 1,
        recoverableGapCount: 0,
      },
      chart: [],
      chains: [{ id: "ethereum", name: "Ethereum" }],
      totalEvents: 5,
    };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));

    const result = await fetchBlacklistSummary();

    expect(result).toEqual(body);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/blacklist-summary");
  });
});
