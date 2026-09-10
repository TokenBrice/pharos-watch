import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { createAdapterIoLimiter } from "../concurrency";
import {
  installAdapterNetwork,
  runAdapter,
  type AdapterNetwork,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";
import type { AdapterContext } from "../types";

const NOW_SEC = 1_800_000_000;
const PRIMARY_URL = "https://api.hive.blog";
const FALLBACK_URL = "https://api.openhive.network";
const PRIMARY_HEAD_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const FALLBACK_HEAD_ID = PRIMARY_HEAD_ID;

function hiveTime(timestamp: number): string {
  return new Date(timestamp * 1_000).toISOString().slice(0, 19);
}

function baseDgp(headBlockId: string = PRIMARY_HEAD_ID, time = hiveTime(NOW_SEC - 30)) {
  return {
    head_block_number: 109_000_000,
    head_block_id: headBlockId,
    time,
    last_irreversible_block_num: 109_000_000,
    current_supply: "574627161.588 HIVE",
    current_hbd_supply: "32267082.665 HBD",
    virtual_supply: "1381304228.213 HIVE",
    hbd_start_percent: 2_000,
    hbd_stop_percent: 2_000,
    hbd_print_rate: 0,
  };
}

function baseFeed() {
  return {
    current_median_history: {
      base: "0.040 HBD",
      quote: "1.000 HIVE",
    },
    market_median_history: {
      base: "0.040 HBD",
      quote: "1.000 HIVE",
    },
  };
}

function baseAccount() {
  return {
    name: "hive.fund",
    hbd_balance: "23191525.049 HBD",
    savings_hbd_balance: "0.000 HBD",
  };
}

interface NodeFixture {
  dgpBefore: Record<string, unknown>;
  dgpAfter: Record<string, unknown>;
  feed: Record<string, unknown>;
  account: Record<string, unknown>;
}

function fixture(dgp: Record<string, unknown> = baseDgp()): NodeFixture {
  return {
    dgpBefore: dgp,
    dgpAfter: { ...dgp },
    feed: baseFeed(),
    account: baseAccount(),
  };
}

function rpcResult(id: number, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

type HiveHook = (
  request: Request,
  body: unknown,
  node: NodeFixture,
) => unknown | Promise<unknown>;

function hiveNetwork(
  overrides: Partial<Record<"primary" | "fallback", Partial<NodeFixture>>> = {},
  hook?: HiveHook,
): AdapterNetworkSpec {
  const fixtures: Record<"primary" | "fallback", NodeFixture> = {
    primary: { ...fixture(), ...overrides.primary },
    fallback: { ...fixture(baseDgp(FALLBACK_HEAD_ID)), ...overrides.fallback },
  };

  const respond = async (request: Request): Promise<unknown> => {
    const url = request.url.replace(/\/+$/, "");
    const node = url === PRIMARY_URL ? fixtures.primary : fixtures.fallback;
    const body = await request.clone().json();
    const override = await hook?.(request, body, node);
    if (override !== undefined) return override;
    if (Array.isArray(body)) {
      const [feedRequest, accountRequest] = body as Array<{ id: number }>;
      return [
        rpcResult(feedRequest.id, node.feed),
        rpcResult(accountRequest.id, [node.account]),
      ];
    }
    const rpc = body as { id: number };
    return rpcResult(rpc.id, rpc.id === 1 ? node.dgpBefore : node.dgpAfter);
  };

  return {
    json: {
      [PRIMARY_URL]: respond,
      [FALLBACK_URL]: respond,
    },
  };
}

async function fetchFixture(
  network: AdapterNetworkSpec | AdapterNetwork = hiveNetwork(),
  config: Partial<LiveReservesConfig> = {},
  ctx?: Partial<AdapterContext>,
) {
  return runAdapter("hive-hbd-protocol", "hbd-hive", {
    network,
    config,
    nowSec: NOW_SEC,
    ctx,
  });
}


describe("hive-hbd-protocol adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a bracketed two-node agreement and emits the reviewed protocol slice", async () => {
    const { result, network } = await fetchFixture();

    expect(result.slices).toEqual([
      expect.objectContaining({
        name: "Hive protocol HIVE conversion mechanism (endogenous HIVE value)",
        pct: 100,
        risk: "high",
      }),
    ]);
    expect(result.slices[0]).not.toHaveProperty("coinId");
    expect(result.metadata).toMatchObject({ freshnessMode: "not-applicable" });
    expect(result.metadata).not.toHaveProperty("sourceTimestamp");
    expect(result.metadata).not.toHaveProperty("collateralizationRatio");
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("supplyUsd");
    expect(result.metadata).not.toHaveProperty("redemption");
    expect(result.metadata?.details).toMatchObject({
      treasuryAccount: "hive.fund",
      thresholdState: "print-stop",
      protocolDebtRatioPct: expect.closeTo(28.31, 2),
    });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "hbd-print-stop-active",
      effect: "info",
    }));
    expect(network.requests).toHaveLength(6);
  });

  it("rejects disagreement in a material feed input", async () => {
    await expect(fetchFixture(hiveNetwork({
      fallback: {
        feed: { ...baseFeed(), current_median_history: { base: "0.041 HBD", quote: "1.000 HIVE" } },
      },
    }))).rejects.toThrow(/ratioBps: primary=2831, fallback=2781/);
  });

  it("rejects a changing head across the material read bracket", async () => {
    await expect(fetchFixture(hiveNetwork({
      primary: { dgpAfter: baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") },
    }))).rejects.toThrow("crossed a changing Hive head");
  });

  it.each([PRIMARY_URL, `${PRIMARY_URL}/`, "https://API.HIVE.BLOG./other-rpc"])(
    "rejects duplicate node hosts before fetching: %s",
    async (url) => {
      await expect(fetchFixture(undefined, {
        inputs: {
          primary: { kind: "http-json", url: PRIMARY_URL },
          fallbacks: [{ kind: "http-json", url }],
        },
      })).rejects.toThrow("two distinct Hive node hosts");
    },
  );

  it("retains the coherent peer through the harness network and I/O limiter after head progression", async () => {
    let active = 0;
    let maxActive = 0;
    const completedBrackets: string[] = [];
    const network = installAdapterNetwork(hiveNetwork({}, async (request, body) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      const url = request.url.replace(/\/+$/, "");
      let payload: unknown;
      if (Array.isArray(body)) {
        const [feedRequest, accountRequest] = body as Array<{ id: number }>;
        const node = url === PRIMARY_URL ? fixture() : fixture(baseDgp(FALLBACK_HEAD_ID));
        payload = [
          rpcResult(feedRequest.id, node.feed),
          rpcResult(accountRequest.id, [node.account]),
        ];
      } else {
        const rpc = body as { id: number };
        const node = url === PRIMARY_URL ? fixture() : fixture(baseDgp(FALLBACK_HEAD_ID));
        const dgp = rpc.id === 1 ? node.dgpBefore : node.dgpAfter;
        payload = rpcResult(rpc.id, dgp);
        if (rpc.id === 4) {
          if (url === PRIMARY_URL && completedBrackets.length < 2) {
            payload = rpcResult(4, baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
          }
          completedBrackets.push(url);
        }
      }
      active -= 1;
      return payload;
    }));
    const { result } = await fetchFixture(network, {}, { ioLimiter: createAdapterIoLimiter(2) });

    expect(result.metadata?.details).toMatchObject({ sourceNodes: [PRIMARY_URL, FALLBACK_URL] });
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
  });

  it("accepts adjacent heads with equal derived material quantities", async () => {
    const adjacent = {
      ...baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", hiveTime(NOW_SEC - 27)),
      head_block_number: 109_000_001,
      last_irreversible_block_num: 108_999_999,
    };
    const { result, network } = await fetchFixture(hiveNetwork({
      fallback: { dgpBefore: adjacent, dgpAfter: adjacent },
    }));
    expect(result.metadata?.details).toMatchObject({ protocolDebtRatioBps: 2831 });
    expect(network.requests).toHaveLength(6);
  });

  it("resamples only the lagging node until it converges beyond one retry", async () => {
    let fallbackSamples = 0;
    const network = hiveNetwork({}, async (request, body) => {
      const url = request.url.replace(/\/+$/, "");
      if (url === FALLBACK_URL && !Array.isArray(body)) {
        const rpc = body as { id: number };
        if (rpc.id === 1) fallbackSamples += 1;
        return rpcResult(rpc.id, {
          ...baseDgp(),
          head_block_number: 109_000_000 - Math.max(0, 7 - fallbackSamples),
          last_irreversible_block_num: 108_999_990,
        });
      }
      return undefined;
    });
    const { result } = await fetchFixture(network);
    expect(result.metadata?.details).toMatchObject({ protocolDebtRatioBps: 2831 });
    expect(fallbackSamples).toBe(4);
  });

  it("does not reset the 19-second budget when resampling", async () => {
    vi.useFakeTimers();
    let reads = 0;
    const network = hiveNetwork({}, async (request, body) => {
      reads += 1;
      if (reads > 6) {
        return new Promise((_, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
        });
      }
      if (!Array.isArray(body) && (body as { id: number }).id === 4) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return rpcResult(4, baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
      }
      return undefined;
    });
    const pending = expect(fetchFixture(network)).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(19_000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed feed payloads", async () => {
    await expect(fetchFixture(hiveNetwork({
      primary: {
        feed: { current_median_history: { base: "0.040 HIVE", quote: "1.000 HBD" } },
      },
    }))).rejects.toThrow("invalid HBD asset format");
  });

  it("rejects stale DGP head time", async () => {
    const stalePrimary = baseDgp(PRIMARY_HEAD_ID, hiveTime(NOW_SEC - 1_801));
    const staleFallback = baseDgp(FALLBACK_HEAD_ID, hiveTime(NOW_SEC - 1_801));
    await expect(fetchFixture(hiveNetwork({
      primary: { dgpBefore: stalePrimary, dgpAfter: stalePrimary },
      fallback: { dgpBefore: staleFallback, dgpAfter: staleFallback },
    }))).rejects.toThrow("head time is stale");
  });

  it("rejects treasury arithmetic that would make counted debt negative", async () => {
    const account = { ...baseAccount(), hbd_balance: "40000000.000 HBD" };
    await expect(fetchFixture(hiveNetwork({ primary: { account }, fallback: { account } })))
      .rejects.toThrow("treasury HBD exceeds current HBD supply");
  });

  it("keeps hard-limit state visible as degraded without clamping the ratio", async () => {
    const feed = { ...baseFeed(), current_median_history: { base: "0.030 HBD", quote: "1.000 HIVE" } };
    const { result } = await fetchFixture(hiveNetwork({ primary: { feed }, fallback: { feed } }));

    expect(result.metadata?.details).toMatchObject({ thresholdState: "hard-limit" });
    expect(result.metadata?.details).toMatchObject({ protocolDebtRatioPct: expect.any(Number) });
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: "hbd-hard-limit-reached",
      effect: "degraded",
    }));
  });
});
