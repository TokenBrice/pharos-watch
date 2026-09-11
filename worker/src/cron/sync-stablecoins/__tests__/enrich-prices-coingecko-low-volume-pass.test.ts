import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { LOW_VOLUME_CG_FALLBACK_IDS, runCoingeckoLowVolumePass } from "../enrich-prices-coingecko-low-volume-pass";
import { fetchCoingeckoSimplePrices } from "../../../lib/coingecko-simple-price";
import { shouldAttemptFetch, recordOutcomeSafe } from "../../../lib/circuit-breaker";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makePeggedAsset } from "./_fixtures";

vi.mock("../../../lib/coingecko-simple-price", () => ({ fetchCoingeckoSimplePrices: vi.fn() }));
vi.mock("../../../lib/circuit-breaker", () => ({ shouldAttemptFetch: vi.fn(), recordOutcomeSafe: vi.fn() }));

beforeEach(() => {
  vi.mocked(shouldAttemptFetch).mockResolvedValue(true);
});
afterEach(() => vi.resetAllMocks());

describe("LOW_VOLUME_CG_FALLBACK_IDS registry invariant", () => {
  it("only references IDs present in the active stablecoin registry", () => {
    const orphaned = [...LOW_VOLUME_CG_FALLBACK_IDS].filter((id) => !ACTIVE_META_BY_ID.has(id));
    expect(orphaned).toEqual([]);
  });

  it("only references IDs that have a configured geckoId", () => {
    const missingGeckoId = [...LOW_VOLUME_CG_FALLBACK_IDS].filter((id) => {
      const meta = ACTIVE_META_BY_ID.get(id);
      return !(typeof meta?.geckoId === "string" && meta.geckoId.length > 0);
    });
    expect(missingGeckoId).toEqual([]);
  });
});

describe("runCoingeckoLowVolumePass", () => {
  it("enriches only allowlisted missing assets, preserving priced and unrelated peers", async () => {
    const assets = [
      makePeggedAsset({ id: "usdn-smardex", price: null }),
      makePeggedAsset({ id: "dllr-sovryn", price: 0.98, priceSource: "defillama" }),
      makePeggedAsset({ id: "usdt-tether", price: null }),
    ];
    vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue({
      kind: "ok", value: new Map(assets.map((asset) => [
        ACTIVE_META_BY_ID.get(asset.id)!.geckoId!, { price: 1.01, observedAt: 1_700_000_000, observedAtMode: "upstream" as const },
      ])),
    });
    expect(await runCoingeckoLowVolumePass(assets, null, undefined)).toEqual({ resolved: 1, failures: [] });
    expect(assets[0]).toMatchObject({ price: 1.01, priceSource: "coingecko-low-volume", priceObservedAt: 1_700_000_000 });
    expect(assets[1]).toMatchObject({ price: 0.98, priceSource: "defillama" });
    expect(assets[2].price).toBeNull();
  });

  it("leaves prices unchanged without requesting an open circuit", async () => {
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const asset = makePeggedAsset({ id: "usdn-smardex", price: null });
    expect(await runCoingeckoLowVolumePass([asset], null, undefined, mockD1([]))).toEqual({ resolved: 0, failures: [] });
    expect(asset.price).toBeNull();
    expect(fetchCoingeckoSimplePrices).not.toHaveBeenCalled();
  });

  it.each(["upstream-error", "ok"] as const)("distinguishes %s from an empty successful provider response", async (kind) => {
    vi.mocked(fetchCoingeckoSimplePrices).mockResolvedValue(kind === "upstream-error"
      ? { kind, value: new Map(), reason: "provider unavailable" }
      : { kind, value: new Map() });
    const asset = makePeggedAsset({ id: "usdn-smardex", price: null });
    expect(await runCoingeckoLowVolumePass([asset], null, undefined, mockD1([]))).toEqual({
      resolved: 0, failures: kind === "upstream-error" ? ["coingecko-low-volume"] : [],
    });
    expect(asset.price).toBeNull();
    expect(recordOutcomeSafe).toHaveBeenCalledWith(expect.anything(), expect.anything(), kind === "ok");
  });
});
