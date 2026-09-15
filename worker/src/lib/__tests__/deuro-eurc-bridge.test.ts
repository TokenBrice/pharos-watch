import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../../cron/sync-stablecoins/enrich-prices-shared";
import code from "./fixtures/deuro-bridge-code.json";
const batch = vi.hoisted(() => vi.fn());
vi.mock("../evm-rpc", () => ({ fetchEvmRpcBatch: batch }));
import { deuroEurcBridgeProvider, fetchDeuroEurcBridgePrice } from "../authoritative-price-sources/deuro-eurc-bridge";
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (a: string) => `0x${a.padStart(64, "0")}`;
const hash = `0x${"12".repeat(32)}`;
let now: number;
let values: unknown[];
function context() {
  return { assetsById: new Map([["eurc-circle", {
    id: "eurc-circle", price: 1.15, priceSource: "coingecko+kraken", priceConfidence: "high",
    priceObservedAt: now - 60, priceObservedAtMode: "local_fetch", priceSyncedAt: now,
  } as PeggedAsset]]) };
}
function healthy() {
  batch.mockResolvedValueOnce([{ number: "0x123", hash, timestamp: `0x${(now - 12).toString(16)}` }])
    .mockImplementationOnce(async () => values).mockResolvedValueOnce([{ hash }]);
}
beforeEach(() => {
  now = Math.floor(Date.now() / 1000);
  batch.mockReset();
  values = [code.bridge, code.token,
    address("1abaea1f7c830bd89acc67ec4af516284b1bc33c"),
    address("ba3f535bbcccca2a154b573ca6c5a49baae0a3ea"),
    word(496_000n * 10n ** 18n), word(1n), word(496_000n * 10n ** 6n), word(6n), word(0n), word(0n)];
});
describe("dEURO exact EURC redemption bridge", () => {
  it("derives current EURC value only with identity, authorization and full bridge coverage", async () => {
    healthy();
    expect(await fetchDeuroEurcBridgePrice(context())).toMatchObject({
      price: 1.15, source: "protocol-redeem", confidence: "high", observedAt: now - 60,
      metadata: { inheritedFrom: "eurc-circle" },
    });
    expect(batch.mock.calls[1][1]).toHaveLength(10);
    for (const call of batch.mock.calls[1][1]) expect(call.params[1]).toEqual({ blockHash: hash, requireCanonical: true });
    expect(deuroEurcBridgeProvider.liveMissingOnly).toBe(true);
  });
  it.each([
    [0, "0x6000", "bridge code drift"], [1, "0x6000", "token code drift"],
    [2, word(0n), "wrong quote token"], [3, word(0n), "wrong target token"],
    [4, word(999n * 10n ** 18n), "insufficient minted capacity"],
    [5, word(0n), "revoked minter"], [6, word(495_999n * 10n ** 6n), "insufficient reserve"],
    [7, word(18n), "wrong decimals"], [8, word(1n), "paused EURC"],
    [9, word(1n), "blacklisted bridge"], [4, "0x01", "malformed word"],
  ])("rejects %s %s (%s)", async (index, value) => {
    values[index as number] = value; healthy();
    expect(await fetchDeuroEurcBridgePrice(context())).toBeNull();
  });
  it("rejects fractional liability undercoverage rather than rounding it away", async () => {
    values[4] = word(496_000n * 10n ** 18n + 1n); healthy();
    expect(await fetchDeuroEurcBridgePrice(context())).toBeNull();
  });
  it("rejects stale or unavailable parent before RPC", async () => {
    const c = context(); c.assetsById.get("eurc-circle")!.priceObservedAt = now - 86400;
    c.assetsById.get("eurc-circle")!.priceSyncedAt = now - 86400;
    expect(await fetchDeuroEurcBridgePrice(c)).toBeNull(); expect(batch).not.toHaveBeenCalled();
  });
  it("rejects stale chain evidence", async () => {
    batch.mockResolvedValueOnce([{ number: "0x123", hash, timestamp: `0x${(now - 301).toString(16)}` }]);
    expect(await fetchDeuroEurcBridgePrice(context())).toBeNull(); expect(batch).toHaveBeenCalledTimes(1);
  });
  it("rejects incomplete batch and canonical identity changes", async () => {
    healthy(); values.pop(); expect(await fetchDeuroEurcBridgePrice(context())).toBeNull();
    values.push(word(0n));
    batch.mockReset().mockResolvedValueOnce([{ number: "0x123", hash, timestamp: `0x${now.toString(16)}` }])
      .mockResolvedValueOnce(values).mockResolvedValueOnce([{ hash: word(99n) }]);
    expect(await fetchDeuroEurcBridgePrice(context())).toBeNull();
  });
  it("propagates caller cancellation", async () => {
    const error = new DOMException("aborted", "AbortError"); batch.mockRejectedValueOnce(error);
    await expect(fetchDeuroEurcBridgePrice(context(), AbortSignal.abort())).rejects.toBe(error);
  });
});
