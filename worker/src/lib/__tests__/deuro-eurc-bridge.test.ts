import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyPrimaryDepegTrust } from "@shared/lib/depeg-primary-trust";
import {
  createDeuroBridgeFixtures,
  EURC_BRIDGE_REJECTION_CASES,
  EURS_BRIDGE_REJECTION_CASES,
  evmWord as word,
  expectPinnedLaneTransportRejections,
  expectPostRpcAgeAndAbort,
  fetchEvmRpcBatchMock as batch,
} from "./authoritative-price-sources.test-support";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { deuroEurcBridgeProvider, fetchDeuroEurcBridgePrice as fetchBridge } from "../authoritative-price-sources/deuro-eurc-bridge";

let now: number;
let fx: ReturnType<typeof createDeuroBridgeFixtures>;

beforeEach(() => {
  vi.useFakeTimers(); now = 1_795_531_300; vi.setSystemTime(now * 1000);
  batch.mockReset(); fx = createDeuroBridgeFixtures(now);
});
afterEach(() => vi.useRealTimers());

describe("dEURO EURC/EURS bridges", () => {
  it("derives EURC value with identity, coverage and RPC routing", async () => {
    fx.mockHealthy(); const chainRpcs = new Map(); const signal = new AbortController().signal;
    expect(await fetchBridge({ ...fx.context(), chainRpcs }, signal)).toMatchObject({
      price: 1.15, source: "protocol-redeem", confidence: "high", observedAt: now - 60, metadata: { inheritedFrom: "eurc-circle" },
    });
    expect(batch.mock.calls[1][1]).toHaveLength(10);
    for (const c of batch.mock.calls[1][1]) expect(c.params[1]).toEqual({ blockHash: fx.hash, requireCanonical: true });
    for (const c of batch.mock.calls) { expect(c[2].chainRpcs).toBe(chainRpcs); expect(c[2].signal).toBe(signal); }
    expect(batch.mock.calls[2][1][0].params).toEqual(["0x123", false]);
    expect(deuroEurcBridgeProvider.liveMissingOnly).toBe(true);
    expect(await deuroEurcBridgeProvider.fetchLivePrice!({ id: "deuro-deuro", price: 1.1, priceSource: "coingecko", priceObservedAt: now } as PeggedAsset, fx.context())).toBeNull();
  });

  it.each(EURC_BRIDGE_REJECTION_CASES)("rejects EURC [%s] (%s)", async (i, v, reason) => {
    fx.eurcState[i] = v; fx.mockHealthy(); const c = fx.context();
    expect(await fetchBridge(c)).toBeNull(); expect(c.lastRejectionReason).toBe(`deuro-eurc-bridge:${reason}`);
  });

  it("falls through to EURS fallback provenance", async () => {
    fx.eurcState[4] = word(377_312_415_461_827n); fx.eurcState[6] = word(528n);
    batch.mockResolvedValueOnce([{ number: "0x123", hash: fx.hash, timestamp: `0x${(now - 12).toString(16)}` }])
      .mockResolvedValueOnce(fx.eurcState).mockResolvedValueOnce(fx.eursState).mockResolvedValueOnce([{ hash: fx.hash }]);
    const c = fx.context({ eurc: true, eurs: true }); const res = await fetchBridge(c);
    expect(res).toMatchObject({
      price: 1.09, source: "protocol-redeem", confidence: "fallback", observedAt: now - 60, observedAtMode: "upstream",
      metadata: { inheritedFrom: "eurs-stasis", parentSource: "coingecko", parentConfidence: "single-source" },
    });
    expect(c.lastRejectionReason).toBeNull(); expect(batch).toHaveBeenCalledTimes(4); expect(batch.mock.calls[2][1]).toHaveLength(14);
    expect(classifyPrimaryDepegTrust({ price: res!.price, priceSource: res!.source, priceConfidence: res!.confidence, priceObservedAt: res!.observedAt, priceObservedAtMode: res!.observedAtMode }, now)).toBe("confirm_required");
    batch.mockReset(); fx.mockHealthy(fx.eursState);
    expect(await fetchBridge(fx.context({ eurs: true, eursObservedAt: now - 2 }))).toMatchObject({ observedAt: now - 12, observedAtMode: "upstream" });
  });

  it.each(EURS_BRIDGE_REJECTION_CASES)("rejects EURS [%s] (%s)", async (i, v, reason) => {
    fx.eursState[i] = v; fx.mockHealthy(fx.eursState); const c = fx.context({ eurs: true });
    expect(await fetchBridge(c)).toBeNull(); expect(c.lastRejectionReason).toBe(`deuro-eurs-bridge:${reason}`);
  });

  it("rejects stale parents, transport, age and abort", async () => {
    const s = fx.context({ eurc: true, eurs: true, eursObservedAt: now - 86400 });
    Object.assign(s.assetsById.get("eurc-circle")!, { priceObservedAt: now - 86400, priceSyncedAt: now - 86400 });
    s.assetsById.get("eurs-stasis")!.priceSyncedAt = now - 86400;
    expect(await fetchBridge(s)).toBeNull(); expect(batch).not.toHaveBeenCalled();
    const base = { fetchPrice: fetchBridge, nowSec: now, hash: fx.hash };
    await expectPinnedLaneTransportRejections({ ...base, makeContext: () => fx.context(), lanePrefix: "deuro-eurc-bridge", state: fx.eurcState });
    await expectPinnedLaneTransportRejections({ ...base, makeContext: () => fx.context({ eurs: true }), lanePrefix: "deuro-eurs-bridge", state: fx.eursState });
    await expectPostRpcAgeAndAbort({ ...base, agingContext: fx.context({ eurs: true, eursObservedAt: now - 890 }), healthyContext: () => fx.context(), lanePrefix: "deuro-eurs-bridge", state: fx.eursState });
  });
});
