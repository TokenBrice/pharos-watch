import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressPriceTarget } from "../address-price-providers";

const { fetchWithRetryMock } = vi.hoisted(() => ({
  fetchWithRetryMock: vi.fn(),
}));

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: fetchWithRetryMock,
}));

import { runMoralisAddressProvider } from "../address-price-providers/moralis";

function makeTarget(index: number): AddressPriceTarget {
  const suffix = index.toString(16).padStart(40, "0");
  return {
    stablecoinId: `coin-${index}`,
    symbol: `C${index}`,
    chain: "ethereum",
    providerChainId: "eth",
    address: `0x${suffix}`,
    origin: "contracts",
    previousSourceDepth: 0,
    missingPrice: false,
    circulatingUsd: 1_000_000,
  };
}

describe("runMoralisAddressProvider", () => {
  beforeEach(() => {
    fetchWithRetryMock.mockReset();
  });

  it("uses 100-token batches and caps requests to keep Moralis daily CU usage bounded", async () => {
    fetchWithRetryMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { tokens?: Array<{ token_address: string }> };
      return Response.json((body.tokens ?? []).map((token) => ({
        tokenAddress: token.token_address,
        usdPrice: "1",
        possibleSpam: false,
        pairTotalLiquidityUsd: "100000",
      })));
    });

    const result = await runMoralisAddressProvider(
      Array.from({ length: 350 }, (_, index) => makeTarget(index)),
      { moralisApiKey: "moralis-key" },
      undefined,
      1_778_600_000,
      Date.now() + 60_000,
    );

    expect(fetchWithRetryMock).toHaveBeenCalledTimes(3);
    expect(fetchWithRetryMock.mock.calls.map(([, init]) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { tokens: unknown[] };
      return body.tokens.length;
    })).toEqual([100, 100, 100]);
    expect(result).toMatchObject({
      attemptedRequests: 3,
      successfulRequests: 3,
      attemptedTargets: 300,
      matchedTargets: 300,
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.matchedCount)).toEqual([100, 100, 100]);
  });
});
