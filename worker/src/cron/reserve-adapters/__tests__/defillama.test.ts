import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

import { fetchWithRetry } from "../../../lib/fetch-retry";
import { fetchDefiLlamaPrices } from "../defillama";

describe("fetchDefiLlamaPrices", () => {
  beforeEach(() => {
    vi.mocked(fetchWithRetry).mockReset();
  });

  it("normalizes addresses and applies DefiLlama chain aliases", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(new Response(JSON.stringify({
      coins: {
        "hyperliquid:0xabc": { price: 1.23 },
      },
    })));

    const prices = await fetchDefiLlamaPrices(
      [{ key: "branch", chain: "hyperevm", address: "0xABC" }],
      new AbortController().signal,
    );

    expect(prices.get("branch")).toBe(1.23);
    expect(vi.mocked(fetchWithRetry).mock.calls[0]?.[0]).toContain("hyperliquid:0xabc");
  });

  it("throws a classified HTTP failure for non-ok responses", async () => {
    vi.mocked(fetchWithRetry).mockResolvedValue(new Response("nope", { status: 503 }));

    await expect(fetchDefiLlamaPrices(
      [{ key: "branch", chain: "ethereum", address: "0xABC" }],
      new AbortController().signal,
    )).rejects.toThrow("DefiLlama price fetch failed (503)");
  });
});
