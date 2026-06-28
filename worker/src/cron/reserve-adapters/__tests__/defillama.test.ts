import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchTextWithRetry: vi.fn(),
}));

import { fetchTextWithRetry } from "../../../lib/fetch-retry";
import { fetchDefiLlamaPrices } from "../defillama";

describe("fetchDefiLlamaPrices", () => {
  beforeEach(() => {
    vi.mocked(fetchTextWithRetry).mockReset();
  });

  it("normalizes addresses and applies DefiLlama chain aliases", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response(),
      body: JSON.stringify({
        coins: {
          "hyperliquid:0xabc": { price: 1.23 },
        },
      }),
    });

    const prices = await fetchDefiLlamaPrices(
      [{ key: "branch", chain: "hyperevm", address: "0xABC" }],
      new AbortController().signal,
    );

    expect(prices.get("branch")).toBe(1.23);
    expect(vi.mocked(fetchTextWithRetry).mock.calls[0]?.[0]).toContain("hyperliquid:0xabc");
  });

  it("throws a classified HTTP failure for non-ok responses", async () => {
    vi.mocked(fetchTextWithRetry).mockResolvedValue({
      response: new Response("nope", { status: 503 }),
      body: "nope",
    });

    await expect(fetchDefiLlamaPrices(
      [{ key: "branch", chain: "ethereum", address: "0xABC" }],
      new AbortController().signal,
    )).rejects.toThrow("DefiLlama price fetch failed (503)");
  });
});
