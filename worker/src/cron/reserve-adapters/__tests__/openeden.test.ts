import { describe, expect, it } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { StablecoinMeta } from "@shared/types/core";
import { adaptOpenEdenUsdo, fetchOpenEdenUsdoReserves } from "../openeden";
import { installAdapterNetwork, runAdapter } from "./reserve-adapter.test-support";
import currentComposition from "./fixtures/openeden-reserve-composition-2026-10-07.json";

const OPENEDEN_URL = "https://prod-gw.openeden.com/usdo/sys/reserve-composition-last";
const FIXTURE_NOW = Math.floor(Date.parse("2026-03-25T09:00:17.600Z") / 1000);

  const payload = {
    date: "2026-03-25T08:00:17.600Z",
    usdoAmount: 100,
    totalTbillAmountInUsd: 70,
    usdcAmount: 15,
    buidlAmount: 5,
    vbillAmount: 10,
    usycAmountInUsd: 0,
    benjiAmount: 0,
    reserveAssetsInUsd: 100,
    ratio: 1,
  };
describe("adaptOpenEdenUsdo", () => {
  it("maps reserve composition fields into reserve slices", () => {
    const result = adaptOpenEdenUsdo({
      date: "2026-03-25T08:00:17.600Z",
      usdoAmount: 62_283_070,
      totalTbillAmountInUsd: 46_831_981.32,
      usdcAmount: 4_767_161.22,
      buidlAmount: 4_568_146.14,
      vbillAmount: 6_372_155.86,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      reserveAssetsInUsd: 62_539_444.54,
      ratio: 100.4116,
    }, OPENEDEN_URL);

    expect(result.slices).toEqual([
      { sourceKey: "openeden-usdo:tbill", name: "OpenEden TBILL", pct: 74.9, risk: "very-low", coinId: "tbill-openeden", depType: "collateral" },
      { sourceKey: "openeden-usdo:vbill", name: "VanEck VBILL", pct: 10.2, risk: "low", coinId: "vbill-vaneck", depType: "collateral" },
      { sourceKey: "openeden-usdo:usdc", name: "USDC buffer", pct: 7.6, risk: "low", coinId: "usdc-circle", depType: "collateral" },
      { sourceKey: "openeden-usdo:buidl", name: "BlackRock BUIDL", pct: 7.3, risk: "low", coinId: "buidl-blackrock", depType: "collateral" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: Date.UTC(2026, 2, 25, 8, 0, 17) / 1000,
      reserveAssetsInUsd: 62_539_444.54,
      supplyUsd: 62_283_070,
      redemption: {
        capacityUsd: 4_767_161.22,
        routeStatus: "unknown",
        routeStatusSource: "static-config",
        holderEligibility: "verified-customer",
      },
    });
  });

  it("includes pendingUsdc in component-total validation", () => {
    // Regression: OpenEden added a pendingUsdc field (USDC from user
    // subscriptions awaiting T-Bill conversion) that contributes to
    // reserveAssetsInUsd. Without this field in the component sum the
    // 1% tolerance check throws for live payloads where pending
    // subscriptions are non-zero. Values mirror the 2026-04-19 live
    // production payload shape: pendingUsdc accounts for ~1.76% of
    // reserveAssetsInUsd, which previously tripped the validation.
    const result = adaptOpenEdenUsdo({
      date: "2026-04-19T00:00:00.000Z",
      usdoAmount: 44_085_617.15,
      totalTbillAmountInUsd: 38_824_683.87,
      usdcAmount: 411_606.20,
      rlusdAmount: 4_000_200,
      buidlAmount: 3_219_897.49,
      vbillAmount: 1_763_678.75,
      usycAmountInUsd: 0,
      benjiAmount: 0,
      pendingUsdc: 864_831.69,
      reserveAssetsInUsd: 49_084_898.00,
      ratio: 111.3399,
    }, OPENEDEN_URL);

    expect(result.slices).toContainEqual({
      sourceKey: "openeden-usdo:pending-usdc",
      name: "Pending USDC",
      pct: 1.8,
      risk: "very-low",
      coinId: "usdc-circle",
      depType: "collateral",
    });
    expect(result.metadata?.componentTotalUsd).toBeCloseTo(49_084_898.00, 2);
    expect(result.metadata).toMatchObject({
      redemption: { capacityUsd: 411_606.20 },
    });
  });

  it("includes the RLUSD component in component-total validation and slices", () => {
    const result = adaptOpenEdenUsdo({ ...payload, usdcAmount: 10, rlusdAmount: 5 }, OPENEDEN_URL);

    expect(result.slices).toContainEqual({
      sourceKey: "openeden-usdo:rlusd",
      name: "RLUSD buffer",
      pct: 5,
      risk: "low",
      coinId: "rlusd-ripple",
      depType: "collateral",
    });
  });

  it.each([1.005, 100.5])("normalizes decimal and percentage ratio %s", (ratio) => {
    expect(adaptOpenEdenUsdo({ ...payload, ratio }, OPENEDEN_URL).metadata?.reserveRatio).toBe(1.005);
  });

  it.each([Number.NaN, 0, -1])("rejects non-numeric or non-positive ratio %s", (ratio) => {
    expect(() => adaptOpenEdenUsdo({ ...payload, ratio }, OPENEDEN_URL)).toThrow(/ratio is non-numeric/);
  });

  const requiredComponents = ["totalTbillAmountInUsd", "usdcAmount", "buidlAmount", "vbillAmount", "usycAmountInUsd", "benjiAmount"];
  it.each(requiredComponents)("rejects every malformed required %s before composition normalization", (field) => {
    for (const invalid of [undefined, null, "0", Number.NaN, Infinity, -0.01]) {
      expect(() => adaptOpenEdenUsdo({ ...payload, [field]: invalid }, OPENEDEN_URL)).toThrow();
    }
  });

  it.each(["rlusdAmount", "pendingUsdc", "uAmount"])("distinguishes absent/observed-zero optional %s from malformed values", (field) => {
    expect(adaptOpenEdenUsdo({ ...payload, [field]: 0 }, OPENEDEN_URL).metadata?.componentTotalUsd).toBe(100);
    for (const invalid of [null, "0", Number.NaN, Infinity, -1]) {
      expect(() => adaptOpenEdenUsdo({ ...payload, [field]: invalid }, OPENEDEN_URL)).toThrow();
    }
  });

  it.each([0.000001, 0.5, 5])("withholds unreviewed positive uAmount %s even inside the reconciliation tolerance", (uAmount) => {
    expect(() => adaptOpenEdenUsdo({ ...payload, uAmount }, OPENEDEN_URL)).toThrow();
  });

  it("reconciles the actual October snapshot and preserves only reported-liability/current-USDC scope", () => {
    const result = adaptOpenEdenUsdo(currentComposition, OPENEDEN_URL);
    expect(result.metadata?.componentTotalUsd).toBe(currentComposition.reserveAssetsInUsd);
    expect(result.metadata?.sourceTimestamp).toBe(Math.floor(Date.parse(currentComposition.date) / 1000));
    expect(result.slices.map((slice) => slice.sourceKey).sort()).toEqual([
      "openeden-usdo:buidl", "openeden-usdo:rlusd", "openeden-usdo:tbill", "openeden-usdo:usdc", "openeden-usdo:vbill",
    ]);
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: currentComposition.usdcAmount,
      sourceUrls: [OPENEDEN_URL, "https://openeden.com/usdo/transparency"],
    });
    expect(result.metadata?.details).toMatchObject({
      liabilityScope: "reported-usdoAmount-only", pendingUsdcExcludedFromCapacity: true,
    });
  });

  it("preserves zero-supply semantics without inventing a coverage denominator", () => {
    const result = adaptOpenEdenUsdo({ ...payload, usdoAmount: 0 }, OPENEDEN_URL);
    expect(result.metadata?.supplyUsd).toBe(0);
    expect(result.metadata?.redemption).not.toHaveProperty("capacityRatioOfSupply");
  });

  it("rejects positive components against an observed zero reserve aggregate", () => {
    expect(() => adaptOpenEdenUsdo({ ...payload, reserveAssetsInUsd: 0, usdoAmount: 0 }, OPENEDEN_URL)).toThrow();
  });
});

describe("fetchOpenEdenUsdoReserves", () => {
  const config: LiveReservesConfig = {
    adapter: "openeden-usdo",
    version: 1,
    semantics: "collateral-mix",
    inputs: { primary: { kind: "http-json", url: OPENEDEN_URL } },
  };
  const coin = { id: "usdo-openeden", liveReservesConfig: config } as StablecoinMeta;

  it.each([0.999, 1.001])("enforces the 1% component boundary: %s", (delta) => {
    const candidate = { ...payload, usdcAmount: 15 + delta };
    if (delta < 1) {
      expect(adaptOpenEdenUsdo(candidate, OPENEDEN_URL).metadata?.componentTotalUsd).toBeCloseTo(100.999, 6);
    } else {
      expect(() => adaptOpenEdenUsdo(candidate, OPENEDEN_URL)).toThrow(/components sum/);
    }
  });

  it.each([0.01999, 0.02001])("enforces the 2% ratio boundary: %s", (delta) => {
    const candidate = { ...payload, usdoAmount: 100 / (1 + delta) };
    if (delta < 0.02) {
      expect(adaptOpenEdenUsdo(candidate, OPENEDEN_URL).metadata?.reserveRatio).toBe(1);
    } else {
      expect(() => adaptOpenEdenUsdo(candidate, OPENEDEN_URL)).toThrow(/does not match derived ratio/);
    }
  });
  it.each(["browser", "neutral", "default"])("recovers through the %s HTTP identity", async (successfulIdentity) => {
    const observed: string[] = [];
    const unexpected: string[] = [];
    const network = installAdapterNetwork({
      json: {
        [OPENEDEN_URL]: (request: Request) => {
          const headers = request.headers;
          const identity = headers.has("origin") ? "browser" : headers.has("accept-language") ? "neutral" : "default";
          observed.push(identity);
          if (request.url !== OPENEDEN_URL || headers.get("accept") !== "application/json"
            || (identity === "browser" && (headers.get("origin") !== "https://openeden.com"
              || headers.get("referer") !== "https://openeden.com/usdo/transparency"))) {
            unexpected.push(request.url);
            return { status: 404, body: "unexpected request" };
          }
          return { status: identity === successfulIdentity ? 200 : 403, json: payload };
        },
      },
    });
    const { result } = await runAdapter("openeden-usdo", coin, {
      network,
      nowSec: FIXTURE_NOW,
    });
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 15 });
    expect(result.slices).toContainEqual({ sourceKey: "openeden-usdo:tbill", name: "OpenEden TBILL", pct: 70, risk: "very-low", coinId: "tbill-openeden", depType: "collateral" });
    expect(observed).toEqual(["browser", "neutral", "default"].slice(0, ["browser", "neutral", "default"].indexOf(successfulIdentity) + 1));
    expect(unexpected).toEqual([]);
  });

  it("reuses a successful request from an initially empty cache", async () => {
    const network = installAdapterNetwork({ json: { [OPENEDEN_URL]: payload } });
    const ctx = { chainRpcs: network.chainRpcs, requestCache: new Map<string, Promise<unknown>>() };
    const first = await fetchOpenEdenUsdoReserves(coin, config, new AbortController().signal, ctx);
    const second = await fetchOpenEdenUsdoReserves(coin, config, new AbortController().signal, ctx);
    expect(second).toEqual(first);
    expect(network.fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the configured API URL in this attempt's route and reserve provenance", async () => {
    const url = `${OPENEDEN_URL}?chainId=60000`;
    const actualConfig = { ...config, inputs: { primary: { kind: "http-json" as const, url } } };
    const network = installAdapterNetwork({ json: { [url]: payload } });
    const result = await fetchOpenEdenUsdoReserves(coin, actualConfig, new AbortController().signal);
    expect(result.metadata?.redemption?.sourceUrls).toEqual([url, "https://openeden.com/usdo/transparency"]);
    expect(result.metadata?.details?.sourceUrls).toEqual([url, "https://openeden.com/usdo/transparency"]);
    expect(network.requests.every((request) => request.url === url)).toBe(true);
  });

  it("labels all-identity HTTP 500 failures without publishing a snapshot", async () => {
    const network = installAdapterNetwork({ json: { [OPENEDEN_URL]: { status: 500, body: "gateway failure" } } });
    await expect(fetchOpenEdenUsdoReserves(coin, config, new AbortController().signal)).rejects.toThrow(/HTTP 500/);
    expect(network.fetchSpy).toHaveBeenCalled();
  });

  it("retains each failed HTTP cause and adapter identity", async () => {
    const network = installAdapterNetwork({
      json: {
        [OPENEDEN_URL]: (request: Request) => {
          const headers = request.headers;
          return {
            status: headers.has("origin") ? 401 : headers.has("accept-language") ? 403 : 404,
            body: "denied",
          };
        },
      },
    });
    const error = await fetchOpenEdenUsdoReserves(
      coin,
      config,
      new AbortController().signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map() },
    ).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    for (const cause of ["openeden-usdo", "HTTP 401", "HTTP 403", "HTTP 404"]) {
      expect((error as Error).message).toContain(cause);
    }
  });

  it("rethrows the original abort without fallback", async () => {
    const network = installAdapterNetwork();
    const abortError = new Error("adapter-timeout");
    const controller = new AbortController();
    controller.abort(abortError);
    await expect(fetchOpenEdenUsdoReserves(
      coin,
      config,
      controller.signal,
      { chainRpcs: network.chainRpcs, requestCache: new Map() },
    )).rejects.toBe(abortError);
    expect(network.fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects a renamed ratio field instead of publishing a plausible snapshot", async () => {
    const drifted = { ...payload };
    Reflect.deleteProperty(drifted, "ratio");
    await expect(runAdapter("openeden-usdo", coin, {
      network: installAdapterNetwork({ json: { [OPENEDEN_URL]: drifted } }),
      nowSec: FIXTURE_NOW,
      validate: false,
    })).rejects.toThrow("ratio is non-numeric");
  });
});
