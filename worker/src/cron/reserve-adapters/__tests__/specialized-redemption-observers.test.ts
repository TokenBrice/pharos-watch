import { describe, expect, it, vi } from "vitest";
import type { EvmMulticall3Call, EvmMulticall3Result } from "../../../lib/evm-rpc";
import { observeExecutableRedemptionRoute, type ExecutableRedemptionObserverDescriptor, type ExecutableRedemptionReadClient } from "../executable-redemption-observers";
import { FOREST_ROAD_USDFR_OBSERVER } from "../forest-road-usdfr-observer";
import { MONETRIX_FUNDED_QUEUE_OBSERVER, observeMonetrixRedeemRequest } from "../monetrix-funded-queue-observer";
import { SATURN_V2_QUEUE_OBSERVER, observeSaturnV2Queue } from "../saturn-v2-queue-observer";
import { APYUSD_UNLOCK_RECEIPT_OBSERVER, observeApyusdUnlockReceipt } from "../apyusd-unlock-receipt-observer";
import forest from "./fixtures/forest-road-observer-pinned.json";
import monetrix from "./fixtures/monetrix-observer-pinned.json";
import saturn from "./fixtures/saturn-observer-pinned.json";
import apyusd from "./fixtures/apyusd-observer-pinned.json";
import { getRedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import { mockD1Strict } from "@shared/test-utils/mock-d1";
import { buildRedemptionBackstopEntry } from "../../../lib/redemption-backstop/sources";
import { resolveExecutableObserverCapacity } from "../../../lib/redemption-backstop-capacity/executable-observer";
import { EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/redemption-backstop-capacity";
import { MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC } from "@shared/lib/live-reserve-freshness";

type Hex = `0x${string}`;
interface Fixture {
  block: { number: number; timestamp: number; hash: string };
  identities: { address: string; codeHash: string; implementationAddress?: string; implementationCodeHash?: string }[];
  calls: { label: string; target: string; callData: string; returnData: string }[];
}
function words(...values: (bigint | number | string)[]): Hex {
  return `0x${values.map(v => (typeof v === "string" ? v.replace(/^0x/, "") : BigInt(v).toString(16)).padStart(64, "0")).join("")}`;
}
interface ClientOptions {
  state?: Partial<Record<string, Hex | null>>;
  identityAddress?: string;
  implementationAddress?: string;
  timestamp?: number;
  hash?: string;
  quote?: Hex | null;
}
function fixtureClient(fixture: Fixture, options: ClientOptions = {}): ExecutableRedemptionReadClient {
  const state = options.state ?? {};
  return {
    blockNumber: async () => fixture.block.number,
    blockTimestamp: async () => options.timestamp ?? fixture.block.timestamp,
    blockHeader: async () => {
      const hash = options.hash ?? fixture.block.hash;
      if (!/^0x[0-9a-f]*$/i.test(hash)) throw new Error("Invalid fixture block hash hex");
      return { ...fixture.block, timestamp: options.timestamp ?? fixture.block.timestamp, hash: hash as Hex };
    },
    codeHash: async address => {
      if (options.identityAddress === address.toLowerCase()) return null;
      const proxy = fixture.identities.find(i => i.address === address.toLowerCase());
      const impl = fixture.identities.find(i => i.implementationAddress === address.toLowerCase());
      return (proxy?.codeHash ?? impl?.implementationCodeHash ?? null) as Hex | null;
    },
    storage: async address => {
      if (options.implementationAddress === address.toLowerCase()) return words(1);
      const id = fixture.identities.find(i => i.address === address.toLowerCase());
      return id?.implementationAddress ? words(id.implementationAddress) : null;
    },
    multicall: async (calls: readonly EvmMulticall3Call[], block, rpcOptions): Promise<EvmMulticall3Result[]> => {
      expect(block).toBe(fixture.block.number);
      expect(rpcOptions.signal?.aborted).not.toBe(true);
      return calls.map(call => {
        const recorded = fixture.calls.find(c => c.target === call.target.toLowerCase() && c.callData.toLowerCase() === call.callData.toLowerCase());
        let raw = state[call.label] !== undefined ? state[call.label] : recorded?.returnData as Hex | undefined;
        if (call.label.startsWith("preview") && options.quote !== undefined) raw = options.quote;
        if (raw === undefined && call.label.startsWith("preview-") && fixture === forest) {
          const input = BigInt(`0x${call.callData.slice(-64)}`);
          raw = words(input / 10n ** 12n, input / 10n ** 12n * 10n ** 12n);
        }
        return { label: call.label, success: raw != null, returnData: raw ?? "0x" };
      });
    },
  };
}
function observe(descriptor: ExecutableRedemptionObserverDescriptor, fixture: Fixture, options: ClientOptions = {}, now = fixture.block.timestamp + 30) {
  return observeExecutableRedemptionRoute(descriptor.coinId, descriptor.inputContract, new AbortController().signal, undefined,
    { client: fixtureClient(fixture, options), nowSec: now }, descriptor.observerId);
}
const CASES = [
  { descriptor: FOREST_ROAD_USDFR_OBSERVER, fixture: forest }, { descriptor: MONETRIX_FUNDED_QUEUE_OBSERVER, fixture: monetrix },
  { descriptor: SATURN_V2_QUEUE_OBSERVER, fixture: saturn }, { descriptor: APYUSD_UNLOCK_RECEIPT_OBSERVER, fixture: apyusd },
];
for (const { descriptor, fixture } of CASES) {
  describe(descriptor.coinId, () => {
    it("retains the original numbered block and source clock", async () => {
      const result = await observe(descriptor, fixture);
      expect(result).toMatchObject({ blockNumber: fixture.block.number, sourceTimestamp: fixture.block.timestamp, outputAssetKeys: [...descriptor.outputAssetKeys] });
      if (descriptor.capacityCapability === "measured") expect(result?.diagnostics.observedBlockHash).toBe(fixture.block.hash);
    });
    for (const call of fixture.calls.filter(c => !c.label.startsWith("preview"))) {
      it(`withholds evidence if required ${call.label} read is absent`, async () => {
        await expect(observe(descriptor, fixture, { state: { [call.label]: null } })).rejects.toThrow();
      });
    }
    for (const identity of fixture.identities) {
      it(`rejects missing or drifted runtime ${identity.address}`, async () => {
        await expect(observe(descriptor, fixture, { identityAddress: identity.address })).rejects.toThrow();
      });
      if (identity.implementationAddress) it(`rejects implementation drift ${identity.address}`, async () => {
        await expect(observe(descriptor, fixture, { implementationAddress: identity.address })).rejects.toThrow();
      });
    }
    for (const { clock, boundary, offsetSec, admitted } of [
      { clock: "stale", boundary: "just inside", offsetSec: EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC - 1, admitted: true },
      { clock: "stale", boundary: "just beyond", offsetSec: EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC + 1, admitted: false },
      { clock: "future", boundary: "just inside", offsetSec: -MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC + 1, admitted: true },
      { clock: "future", boundary: "just beyond", offsetSec: -MAX_FUTURE_SOURCE_TIMESTAMP_SKEW_SEC - 1, admitted: false },
    ]) {
      it(`${admitted ? "admits" : "rejects"} ${clock} clocks ${boundary} the shared freshness authority`, async () => {
        const observation = observe(descriptor, fixture, {}, fixture.block.timestamp + offsetSec);
        if (admitted) {
          await expect(observation).resolves.toMatchObject({
            blockNumber: fixture.block.number, sourceTimestamp: fixture.block.timestamp,
          });
        } else {
          await expect(observation).rejects.toThrow("block timestamp is unavailable or out of range");
        }
      });
    }
  });
}
describe("native quote guards remain independent of all-in USD admission", () => {
  for (const { descriptor, fixture, pause } of [
    { descriptor: FOREST_ROAD_USDFR_OBSERVER, fixture: forest, pause: "controller-paused" },
    { descriptor: APYUSD_UNLOCK_RECEIPT_OBSERVER, fixture: apyusd, pause: "vault-paused" },
  ]) {
    it(`${descriptor.coinId} retains one quote batch without inventing all-in cost evidence`, async () => {
      const client = fixtureClient(fixture);
      const multicall = vi.spyOn(client, "multicall");
      const result = await observeExecutableRedemptionRoute(descriptor.coinId, descriptor.inputContract,
        new AbortController().signal, undefined, { client, nowSec: fixture.block.timestamp + 30 }, descriptor.observerId);
      expect(result).toMatchObject({ capacityState: "measured", routeStatus: "open", allInFeeBps: null });
      const quoteBatches = multicall.mock.calls.filter(([calls]) => calls.some(c => c.label.startsWith("preview")));
      expect(quoteBatches).toHaveLength(1);
      expect(quoteBatches[0][0].length).toBeGreaterThan(0);
      const config = getRedemptionBackstopConfig(descriptor.coinId)!;
      if (config.capacityModel.kind !== "executable-observer") throw new Error("Specialized route not activated");
      const capacity = resolveExecutableObserverCapacity(config.capacityModel, {
        db: mockD1Strict([]), stablecoinId: descriptor.coinId, supplyUsd: 200_000_000,
        now: fixture.block.timestamp + 30, options: { executableRedemptionObservation: result },
      });
      expect(capacity.eventualCapacityUsd).toBeNull();
      expect(capacity.immediateCapacityUsd).toBeNull();
    });
    it(`${descriptor.coinId} cannot certify measured/open after missing previews even without cost proof`, async () => {
      await expect(observe(descriptor, fixture, { quote: null })).rejects.toThrow();
    });
    it(`${descriptor.coinId} preserves adverse status while already avoiding unnecessary quote calls`, async () => {
      const client = fixtureClient(fixture, { state: { [pause]: words(1) }, quote: null });
      const multicall = vi.spyOn(client, "multicall");
      const result = await observeExecutableRedemptionRoute(descriptor.coinId, descriptor.inputContract,
        new AbortController().signal, undefined, { client, nowSec: fixture.block.timestamp + 30 }, descriptor.observerId);
      expect(result).toMatchObject({ capacityState: "closed", capacityRaw: 0n, routeStatus: "paused", allInFeeBps: null });
      expect(multicall.mock.calls.some(([calls]) => calls.some(c => c.label.startsWith("preview")))).toBe(false);
      expect(multicall.mock.calls.some(([calls]) => calls.some(c => c.label === pause))).toBe(true);
    });
  }
});
describe("USDfr exact par controller", () => {
  it("measures only guarded cash and only the KYC holder cohort", async () => {
    const r = await observe(FOREST_ROAD_USDFR_OBSERVER, forest);
    expect(r).toMatchObject({ capacityRaw: 138874406506n, capacityState: "measured", feeBps: 0, holderEligibility: "whitelisted-primary", underlyingDecimals: 6 });
    expect(r?.diagnostics).toMatchObject({ anyHolderCertified: false, gasCostVerified: false, reserveCompositionUsedAsCapacity: false });
    expect(r?.diagnostics.quotes).toContainEqual({ inputRaw: "100000000000000000000000", outputRaw: "100000000000", burnedRaw: "100000000000000000000000", supportedByInventory: true });
    expect(r?.diagnostics.quotes).toContainEqual({ inputRaw: "1000000000000000000000000", outputRaw: "1000000000000", burnedRaw: "1000000000000000000000000", supportedByInventory: false });
  });
  for (const label of ["controller-paused", "reserve-paused", "token-paused", "usdc-paused", "reserve-blacklisted"]) {
    it(`records measured closure for ${label}`, async () => {
      expect(await observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { [label]: words(1) } })).toMatchObject({ capacityRaw: 0n, capacityState: "closed", routeStatus: "paused" });
    });
  }
  it("does not substitute physical donations for the recorded idle ledger", async () => {
    expect((await observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { physical: words(200000000000n) } }))?.capacityRaw).toBe(138874406506n);
  });
  it("closes the custodied par path when the ledger is short", async () => {
    expect(await observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { physical: words(1) } })).toMatchObject({ capacityState: "closed", capacityRaw: 0n });
    expect(await observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { "custody-shortfall": words(1) } })).toMatchObject({ capacityState: "closed" });
  });
  it("distinguishes genuine zero idle from a failed read", async () => {
    expect(await observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { idle: words(0), physical: words(0) } })).toMatchObject({ capacityState: "measured", capacityRaw: 0n, routeStatus: "open" });
  });
  it("caps the supported input by supply rather than overquoting or accepting dust", async () => {
    const r = await observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { "effective-supply": words(2000000000000n), supply: words(2000000000000n) } });
    expect(r?.capacityRaw).toBe(2n);
    await expect(observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { "effective-supply": words(1) } })).rejects.toThrow();
  });
  for (const state of [{ "controller-role": words(0) }, { "minter-role": words(0) }, { "usdc-decimals": words(18) }, { "token-decimals": words(6) }, { usdc: words(1) }, { "token-compliance": words(1) }, { modules: words(1, 2, 3) }]) {
    it("withholds capacity on authority, decimals or module drift", async () => { await expect(observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state })).rejects.toThrow(); });
  }
  it("closes the unratified custody arm independently of inventory", async () => {
    expect(await observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { arm: words(1, 2, 0, 1) } })).toMatchObject({ capacityState: "closed" });
  });
  it("supports ratified arm state without falsely retaining its freeze", async () => {
    expect(await observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { arm: words(1, 2, 0, 1), incident: words(2, 0) } })).toMatchObject({ capacityState: "measured" });
  });
  it("rejects underbacking and unsupported junior-draw arithmetic", async () => {
    await expect(observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { "backing-invariant": words(0) } })).rejects.toThrow();
    await expect(observe(FOREST_ROAD_USDFR_OBSERVER, forest, { state: { backing: words(1) } })).rejects.toThrow();
  });
  for (const quote of [null, words(0, 0), words(1, 1)]) it("rejects missing, sub-par or mismatched same-notional quotes", async () => {
    await expect(observe(FOREST_ROAD_USDFR_OBSERVER, forest, { quote })).rejects.toThrow();
  });
  it("rejects a mismatched block hash identity", async () => {
    await expect(observe(FOREST_ROAD_USDFR_OBSERVER, forest, { hash: "0x1234" })).rejects.toThrow();
  });
});
describe("Monetrix pooled escrow", () => {
  it("reports the actual funded shortfall and current two-day new-request cooldown without zero capacity", async () => {
    const r = await observe(MONETRIX_FUNDED_QUEUE_OBSERVER, monetrix);
    expect(r).toMatchObject({ capacityState: "unquantified", capacityRaw: 0n, settlementBoundUnproven: true, routeStatus: "open", feeBps: null });
    expect(r?.diagnostics).toMatchObject({ escrowBalanceRaw: "45946339767", totalOwedRaw: "46899380174", shortfallRaw: "953040407", currentNewRequestCooldownSec: 172800,
      cooldownAppliesTo: "new-requests-only", existingRequestCooldownEnd: "stored-per-request", requestAction: "transfer-usdm-to-vault", claimAction: "burn-usdm-then-escrow-payout" });
  });
  it("does not treat an operator pause as a holder claim pause", async () => {
    expect(await observe(MONETRIX_FUNDED_QUEUE_OBSERVER, monetrix, { state: { "operator-paused": words(1) } })).toMatchObject({ routeStatus: "open", capacityState: "unquantified" });
    expect(await observe(MONETRIX_FUNDED_QUEUE_OBSERVER, monetrix, { state: { paused: words(1) } })).toMatchObject({ routeStatus: "paused", capacityState: "unquantified" });
  });
  it("keeps fully funded escrow and paid-down obligations diagnostic-only", async () => {
    const r = await observe(MONETRIX_FUNDED_QUEUE_OBSERVER, monetrix, { state: { owed: words(100), balance: words(200), "vault-shortfall": words(0), "escrow-shortfall": words(0), cooldown: words(86400) } });
    expect(r).toMatchObject({ capacityState: "unquantified", capacityRaw: 0n });
    expect(r?.diagnostics).toMatchObject({ totalOwedRaw: "100", currentNewRequestCooldownSec: 86400, shortfallRaw: "0" });
  });
  for (const label of ["usdc", "usdm", "escrow", "config", "escrow-vault", "escrow-usdc"]) it(`rejects ${label} pointer drift`, async () => {
    await expect(observe(MONETRIX_FUNDED_QUEUE_OBSERVER, monetrix, { state: { [label]: words(1) } })).rejects.toThrow();
  });
  it("rejects decimals, obligation inconsistency and invalid config cooldown", async () => {
    for (const state of [{ "usdc-decimals": words(18) }, { "usdm-decimals": words(18) }, { "vault-shortfall": words(0) }, { cooldown: words(0) }]) await expect(observe(MONETRIX_FUNDED_QUEUE_OBSERVER, monetrix, { state })).rejects.toThrow();
  });
});
describe("Saturn V2 queue", () => {
  it("keeps current 50bps process-time fee and both inventories diagnostic-only", async () => {
    const r = await observe(SATURN_V2_QUEUE_OBSERVER, saturn);
    expect(r).toMatchObject({ capacityState: "unquantified", capacityRaw: 0n, feeBps: 50, settlementBoundUnproven: true });
    expect(r?.diagnostics).toMatchObject({ currentEffectiveFeeBps: 50, baseFeeBps: 10, elevatedFeeBps: 50, inventoriesSummedAsCapacity: false, feeFixedAt: "process-time" });
  });
  for (const label of ["share-paused", "queue-paused", "queue-frozen"]) it(`retains distinct ${label} and no invented capacity`, async () => {
    expect(await observe(SATURN_V2_QUEUE_OBSERVER, saturn, { state: { [label]: words(1) } })).toMatchObject({ routeStatus: "paused", capacityState: "unquantified" });
  });
  it("rejects fee parameters outside the verified 500bps and ordered-mode bounds", async () => {
    for (const state of [{ "base-fee": words(51) }, { "elevated-fee": words(501), fee: words(501) }, { mode: words(2) }, { decimals: words(18) }]) {
      await expect(observe(SATURN_V2_QUEUE_OBSERVER, saturn, { state })).rejects.toThrow();
    }
  });
  it("rejects expired regular mode and fee inconsistency", async () => {
    await expect(observe(SATURN_V2_QUEUE_OBSERVER, saturn, { state: { mode: words(0), fee: words(10) } })).rejects.toThrow();
    await expect(observe(SATURN_V2_QUEUE_OBSERVER, saturn, { state: { fee: words(0) } })).rejects.toThrow();
    expect(await observe(SATURN_V2_QUEUE_OBSERVER, saturn, { state: { mode: words(0), fee: words(10), "mode-expiry": words(saturn.block.timestamp + 3600) } })).toMatchObject({ feeBps: 10 });
  });
  for (const label of ["asset", "queue", "queue-asset", "queue-share"]) it(`rejects ${label} identity drift`, async () => {
    await expect(observe(SATURN_V2_QUEUE_OBSERVER, saturn, { state: { [label]: words(1) } })).rejects.toThrow();
  });
  it("only certifies a supplied processed owner claim, not new-holder throughput", async () => {
    const owner = "0x1111111111111111111111111111111111111111";
    for (const status of [1, 2, 3, 4, 5]) {
      const client = fixtureClient(saturn, { state: { owner: words(owner), request: words(1, 1, saturn.block.timestamp, 1, status), "owner-blacklisted": words(0), "owner-frozen": words(0) } });
      const r = await observeSaturnV2Queue(saturn.block.number, saturn.block.timestamp, {}, client, undefined, new AbortController().signal, { tokenId: 1n, owner });
      expect(r.capacityState).toBe("unquantified");
      expect(r.diagnostics.exactRequest).toMatchObject({ status, ownerClaimable: status === 3, newHolderCapacity: false });
    }
    for (const label of ["owner-blacklisted", "owner-frozen", "queue-paused"]) {
      const client = fixtureClient(saturn, { state: { owner: words(owner), request: words(1, 1, 1, 1, 3), "owner-blacklisted": words(0), "owner-frozen": words(0), [label]: words(1) } });
      const r = await observeSaturnV2Queue(saturn.block.number, saturn.block.timestamp, {}, client, undefined, new AbortController().signal, { tokenId: 1n, owner });
      expect(r.diagnostics.exactRequest).toMatchObject({ ownerClaimable: false });
    }
  });
});
describe("apyUSD new UnlockReceipt funding", () => {
  it("measures idle-funded post-fee receipts without existing escrow or unliquid vested yield", async () => {
    const r = await observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd);
    expect(r).toMatchObject({ capacityRaw: 166373079492689462764770535n, capacityState: "measured", settlementDelaySec: 1728000, feeBps: 10, allInFeeBps: null });
    expect(r?.settlementBoundUnproven).toBeUndefined();
    expect(r?.diagnostics).toMatchObject({ minClaimDurationSec: 259200, minFeeDurationSec: 1728000, existingEscrowIncludedInCapacity: false, vestedYieldUsedAsLiquidity: false,
      sharesBurnedRaw: "115754082613999509610328486", upfrontFeeRaw: "166373079492689462764771", atomic300SecondCredit: false, scheduleMutableForExistingReceipts: true });
  });
  it("records true zero idle without using NAV or existing receipt escrow", async () => {
    const vested = BigInt(apyusd.calls.find(c => c.label === "vested")!.returnData);
    expect(await observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { state: { idle: words(0), "total-assets": words(vested) } })).toMatchObject({ capacityState: "measured", capacityRaw: 0n });
  });
  it("does not subtract already excluded old receipt assets twice", async () => {
    expect((await observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { state: { "existing-escrow": words(10n ** 30n) } }))?.capacityRaw).toBe(166373079492689462764770535n);
  });
  for (const label of ["vault-paused", "receipt-paused", "asset-paused", "vault-denied", "receipt-denied", "vault-fee-wallet-denied", "receipt-fee-wallet-denied"]) it(`measures closure for ${label}`, async () => {
    expect(await observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { state: { [label]: words(1) } })).toMatchObject({ capacityState: "closed", capacityRaw: 0n });
  });
  it("uses a supplied real owner and withholds denied-owner capacity", async () => {
    const owner = "0x1111111111111111111111111111111111111111";
    const r = await observeApyusdUnlockReceipt(apyusd.block.number, apyusd.block.timestamp, {}, fixtureClient(apyusd, { state: { "owner-denied": words(1) } }), undefined, new AbortController().signal, owner);
    expect(r).toMatchObject({ capacityState: "closed", capacityRaw: 0n });
  });
  for (const label of ["asset", "receipt", "receipt-asset", "receipt-vault", "vault-list", "asset-list", "vesting", "vesting-asset", "vesting-beneficiary", "vault-fee-wallet", "receipt-fee-wallet"]) it(`rejects ${label} drift`, async () => {
    await expect(observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { state: { [label]: words(1) } })).rejects.toThrow();
  });
  it("rejects malformed/reversed/out-of-bound curves", async () => {
    for (const curve of [words(0, 0), words(0, 1, 20, 10, 10n ** 18n), words(0, 1, 0, 10, 10n ** 18n), words(0, 1, 1, 10000000, 10n ** 18n), words(1, 0, 1, 10, 10n ** 18n), words(0, 10n ** 18n, 1, 10, 10n ** 18n), words(0, 1, 1, 10, 0)]) {
      await expect(observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { state: { "fee-curve": curve } })).rejects.toThrow();
    }
  });
  it("requires funded and unrestricted vested-yield delivery without counting it as capacity", async () => {
    await expect(observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { state: { "vesting-physical": words(0) } })).rejects.toThrow();
    expect(await observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { state: { "vesting-denied": words(1) } })).toMatchObject({ capacityState: "closed", capacityRaw: 0n });
  });
  it("rejects decimal and ceil conversion drift", async () => {
    for (const label of ["vault-decimals", "asset-decimals"]) await expect(observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { state: { [label]: words(6) } })).rejects.toThrow();
    await expect(observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd, { quote: words(1) })).rejects.toThrow();
  });
});

describe("registered apyUSD source-to-capacity admission", () => {
  it("admits only the measured queued output with complete valuation/cost proof, never immediate credit", async () => {
    const config = getRedemptionBackstopConfig("apyusd-apyx")!;
    const observation = await observe(APYUSD_UNLOCK_RECEIPT_OBSERVER, apyusd);
    expect(observation).not.toBeNull();
    const now = apyusd.block.timestamp + 30;
    const db = mockD1Strict([]);
    const admitted = await buildRedemptionBackstopEntry(db, "apyusd-apyx", config, 200_000_000, null, now, {
      executableRedemptionObservation: { ...observation!, allInFeeBps: 15 },
      executableObserverValuation: { outputAssetKey: "apxusd-apyx", priceUsd: 1, observedAt: now },
    });
    expect(admitted.capacityBasis).toBe("live-direct-telemetry");
    expect(admitted.capacityProfile?.eventualUsd).toBeCloseTo(166_373_079.49268946, 6);
    expect(admitted.immediateCapacityUsd).toBeNull();
    expect(admitted.capacityProfile?.scoringUsd).toBeNull();
    for (const override of [
      { executableObserverValuation: null },
      { executableRedemptionObservation: { ...observation!, allInFeeBps: null } },
      { executableRedemptionObservation: { ...observation!, allInFeeBps: 15, outputAssetKeys: ["usdc-circle"] } },
      { executableRedemptionObservation: { ...observation!, allInFeeBps: 15, sourceTimestamp: now - EXECUTABLE_REDEMPTION_OBSERVATION_MAX_AGE_SEC - 1 } },
    ]) {
      const entry = await buildRedemptionBackstopEntry(db, "apyusd-apyx", config, 200_000_000, null, now, {
        executableRedemptionObservation: { ...observation!, allInFeeBps: 15 },
        executableObserverValuation: { outputAssetKey: "apxusd-apyx", priceUsd: 1, observedAt: now },
        ...override,
      });
      expect(entry.immediateCapacityUsd).toBeNull();
      expect(entry.capacityProfile?.eventualUsd).toBeNull();
      expect(entry.capacityProfile?.scoringUsd).toBeNull();
    }
    if (config.capacityModel.kind !== "executable-observer") throw new Error("apyUSD specialized route model not activated");
    const absent = resolveExecutableObserverCapacity(config.capacityModel, {
      db, stablecoinId: "apyusd-apyx", supplyUsd: 200_000_000, now, options: { executableRedemptionObservation: null },
    });
    expect(absent.eventualCapacityUsd).toBeNull();
    expect(absent.immediateCapacityUsd).toBeNull();
  });
});

describe("Monetrix request-local deadlines", () => {
  const owner = "0x1111111111111111111111111111111111111111";
  const base = {
    requestId: 1n, owner, blockNumber: monetrix.block.number, blockTimestamp: monetrix.block.timestamp,
    rpcOptions: {}, signal: new AbortController().signal,
  };
  it("preserves a matured stored cooldown despite a changed new-request delay", async () => {
    const r = await observeMonetrixRedeemRequest({
      ...base, client: fixtureClient(monetrix, { state: { request: words(owner, monetrix.block.timestamp - 1, 100), cooldown: words(30 * 86400) } }),
    });
    expect(r).toMatchObject({ cooldownMatured: true, storedCooldownEnd: String(monetrix.block.timestamp - 1), currentNewRequestCooldownSec: 30 * 86400,
      claimCompletionGuaranteed: false, capacityState: "unquantified" });
  });
  it("does not mature an existing request when governance shortens new-request cooldown", async () => {
    const r = await observeMonetrixRedeemRequest({
      ...base, client: fixtureClient(monetrix, { state: { request: words(owner, monetrix.block.timestamp + 86400, 100), cooldown: words(60) } }),
    });
    expect(r.cooldownMatured).toBe(false);
  });
  it("distinguishes a completed/absent request and rejects wrong-owner evidence", async () => {
    const r = await observeMonetrixRedeemRequest({ ...base, client: fixtureClient(monetrix, { state: { request: words(0, 0, 0) } }) });
    expect(r).toMatchObject({ status: "absent-or-completed", storedCooldownEnd: null, cooldownMatured: false });
    await expect(observeMonetrixRedeemRequest({ ...base, client: fixtureClient(monetrix, { state: { request: words(1, 1, 100) } }) })).rejects.toThrow();
  });
});
