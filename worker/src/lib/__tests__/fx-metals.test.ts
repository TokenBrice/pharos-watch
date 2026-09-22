import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../fetch-retry", () => ({
  fetchJsonWithRetry: vi.fn(),
}));

import { fetchJsonWithRetry } from "../fetch-retry";
import { resolveMetalReferenceRates, type MetalPegKey } from "../fx-metals";

const validateMetalRate = (pegKey: MetalPegKey, rate: number): boolean =>
  pegKey === "peggedGOLD"
    ? rate >= 500 && rate <= 10_000
    : rate >= 5 && rate <= 500;

describe("resolveMetalReferenceRates", () => {
  beforeEach(() => {
    vi.mocked(fetchJsonWithRetry).mockReset();
  });

  it("does not carry forward cached metal rates outside current bounds", async () => {
    vi.mocked(fetchJsonWithRetry).mockResolvedValue(null);

    const result = await resolveMetalReferenceRates({
      prevRates: { peggedGOLD: 100, peggedSILVER: 1_000 },
      commodityPeerMedian: { rates: {}, updatedAt: null },
      syncStartSec: 1_800_000_000,
      validateRate: validateMetalRate,
    });

    expect(result.resolvedByPeg.peggedGOLD).toBeUndefined();
    expect(result.resolvedByPeg.peggedSILVER).toBeUndefined();
  });

  it("does not synthesize provenance for live or peer-median metal values", async () => {
    vi.mocked(fetchJsonWithRetry)
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ price: 2_900 }), { status: 200 }),
        body: { price: 2_900 },
      })
      .mockResolvedValueOnce({
        response: new Response(JSON.stringify({ price: 32 }), { status: 200 }),
        body: { price: 32 },
      });

    const live = await resolveMetalReferenceRates({
      prevRates: {},
      commodityPeerMedian: { rates: {}, updatedAt: null },
      syncStartSec: 1_800_000_000,
      validateRate: validateMetalRate,
    });
    expect(live.resolvedByPeg.peggedGOLD).toMatchObject({
      source: "gold-api.com",
      updatedAt: null,
    });

    vi.mocked(fetchJsonWithRetry).mockReset().mockResolvedValue(null);
    const peer = await resolveMetalReferenceRates({
      prevRates: {},
      commodityPeerMedian: { rates: { peggedGOLD: 2_900 }, updatedAt: null },
      syncStartSec: 1_800_000_000,
      validateRate: validateMetalRate,
    });
    expect(peer.resolvedByPeg.peggedGOLD).toMatchObject({
      source: "commodity-peer-median",
      updatedAt: null,
    });
  });
});
