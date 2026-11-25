import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyPrimaryDepegTrust } from "@shared/lib/depeg-primary-trust";
import {
  asset,
  createDeuroBridgeFixtures,
  EURC_BRIDGE_REJECTION_CASES,
  EURS_BRIDGE_REJECTION_CASES,
  evmWord as word,
  fetchEvmRpcBatchMock as batch,
  fetchLiveOverrides,
} from "./authoritative-price-sources.test-support";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import { createAuthoritativeLivePriceOverrideStats } from "../authoritative-price-sources";
import { deuroEurcBridgeProvider, fetchDeuroEurcBridgePrice as fetchBridge } from "../authoritative-price-sources/deuro-eurc-bridge";

const EURC_MISSING = "deuro-eurc-bridge:untrusted-parent:eurc-circle:parent-asset-missing";
const EURS_MISSING = "deuro-eurs-bridge:untrusted-parent:eurs-stasis:parent-asset-missing";

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
    expect(await fetchBridge(c)).toBeNull();
    expect(c.lastRejectionReason).toBe(`deuro-eurc-bridge:${reason}+${EURS_MISSING}`);
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

  it("reports both EURC failure and EURS untrusted-parent or lane refusal in the ledger", async () => {
    fx.eurcState[4] = word(377_312_415_461_827n); fx.eurcState[6] = word(528n);
    const head = [{ number: "0x123", hash: fx.hash, timestamp: `0x${(now - 12).toString(16)}` }];
    batch.mockResolvedValueOnce(head).mockResolvedValueOnce(fx.eurcState);
    const lowEurs = fx.context({ eurc: true, eurs: true });
    lowEurs.assetsById.get("eurs-stasis")!.priceConfidence = "low";
    const stats = createAuthoritativeLivePriceOverrideStats();
    const overrides = await fetchLiveOverrides([asset("deuro-deuro"), ...lowEurs.assetsById.values()], { stats });
    expect(overrides.has("deuro-deuro")).toBe(false);
    expect(stats.assetAttempts.find((row) => row.assetId === "deuro-deuro")).toMatchObject({
      result: "empty",
      rejectionClass: "deuro-eurc-bridge:capacity-insufficient+deuro-eurs-bridge:untrusted-parent:eurs-stasis:confidence-low",
    });

    fx.eursState[8] = word(999n * 10n ** 18n);
    batch.mockReset().mockResolvedValueOnce(head).mockResolvedValueOnce(fx.eurcState).mockResolvedValueOnce(fx.eursState);
    const both = fx.context({ eurc: true, eurs: true });
    expect(await fetchBridge(both)).toBeNull();
    expect(both.lastUntrustedParent).toBeNull();
    expect(both.lastRejectionReason).toBe("deuro-eurc-bridge:capacity-insufficient+deuro-eurs-bridge:capacity-insufficient");
  });

  it.each(EURS_BRIDGE_REJECTION_CASES)("rejects EURS [%s] (%s)", async (i, v, reason) => {
    fx.eursState[i] = v; fx.mockHealthy(fx.eursState); const c = fx.context({ eurs: true });
    expect(await fetchBridge(c)).toBeNull();
    expect(c.lastRejectionReason).toBe(`${EURC_MISSING}+deuro-eurs-bridge:${reason}`);
  });

  it("rejects stale parents, transport, age and abort", async () => {
    const s = fx.context({ eurc: true, eurs: true, eursObservedAt: now - 86400 });
    Object.assign(s.assetsById.get("eurc-circle")!, { priceObservedAt: now - 86400, priceSyncedAt: now - 86400 });
    s.assetsById.get("eurs-stasis")!.priceSyncedAt = now - 86400;
    expect(await fetchBridge(s)).toBeNull(); expect(batch).not.toHaveBeenCalled();
    expect(s.lastUntrustedParent).toBeNull();
    expect(s.lastRejectionReason).toContain("deuro-eurc-bridge:untrusted-parent:eurc-circle:freshness-");
    expect(s.lastRejectionReason).toContain("+deuro-eurs-bridge:untrusted-parent:eurs-stasis:freshness-");

    const head = [{ number: "0x123", hash: fx.hash, timestamp: `0x${(now - 5).toString(16)}` }];
    for (const [makeContext, lane, state, sibling] of [
      [() => fx.context(), "deuro-eurc-bridge", fx.eurcState, (r: string) => `${r}+${EURS_MISSING}`],
      [() => fx.context({ eurs: true }), "deuro-eurs-bridge", fx.eursState, (r: string) => `${EURC_MISSING}+${r}`],
    ] as const) {
      for (const [res, reason] of [
        [null, "head-unavailable"], [[{ number: "invalid", hash: fx.hash, timestamp: "0x1" }], "head-invalid"],
        [[{ number: "0x0", hash: fx.hash, timestamp: "0x1" }], "head-invalid"],
        [[{ number: "0x123", hash: fx.hash, timestamp: `0x${(now - 301).toString(16)}` }], "head-stale-or-invalid"],
      ] as const) {
        batch.mockReset().mockResolvedValueOnce(res); const c = makeContext();
        expect(await fetchBridge(c)).toBeNull(); expect(c.lastRejectionReason).toBe(`${lane}:${reason}`);
      }
      for (const [b2, b3, reason] of [
        [null, [{ hash: fx.hash }], "state-unavailable"], [state.slice(0, -1), [{ hash: fx.hash }], "state-invalid"],
        [state, [{ hash: word(99n) }], "canonical-check-failed"],
      ] as const) {
        batch.mockReset().mockResolvedValueOnce(head).mockResolvedValueOnce(b2).mockResolvedValueOnce(b3);
        const c = makeContext(); expect(await fetchBridge(c)).toBeNull();
        expect(c.lastRejectionReason).toBe(sibling(`${lane}:${reason}`));
      }
    }
    const aging = fx.context({ eurs: true, eursObservedAt: now - 890 });
    batch.mockReset().mockResolvedValueOnce(head)
      .mockImplementationOnce(async () => { vi.setSystemTime((now + 20) * 1000); return fx.eursState; })
      .mockResolvedValueOnce([{ hash: fx.hash }]);
    expect(await fetchBridge(aging)).toBeNull();
    expect(aging.lastRejectionReason).toBe(`${EURC_MISSING}+deuro-eurs-bridge:dependency-age`);
    const err = new DOMException("aborted", "AbortError");
    batch.mockReset().mockRejectedValueOnce(err);
    await expect(fetchBridge(fx.context(), AbortSignal.abort())).rejects.toBe(err);
  });
});
