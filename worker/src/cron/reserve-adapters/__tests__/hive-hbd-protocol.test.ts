import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchHiveHbdProtocolReserves } from "../hive-hbd-protocol";
import { createAdapterIoLimiter } from "../concurrency";

const rpc = vi.hoisted(() => ({
  fetchJsonPostWithRetry: vi.fn(),
}));

vi.mock("../request", () => rpc);

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

function installRpcFixtures(overrides: Partial<Record<"primary" | "fallback", Partial<NodeFixture>>> = {}) {
  const fixtures: Record<"primary" | "fallback", NodeFixture> = {
    primary: { ...fixture(), ...overrides.primary },
    fallback: { ...fixture(baseDgp(FALLBACK_HEAD_ID)), ...overrides.fallback },
  };

  rpc.fetchJsonPostWithRetry.mockImplementation(async (url: string, body: unknown) => {
    const node = url === PRIMARY_URL ? fixtures.primary : fixtures.fallback;
    if (Array.isArray(body)) {
      const [feedRequest, accountRequest] = body as Array<{ id: number }>;
      return [
        rpcResult(feedRequest.id, node.feed),
        rpcResult(accountRequest.id, [node.account]),
      ];
    }

    const request = body as { id: number };
    return rpcResult(request.id, request.id === 1 ? node.dgpBefore : node.dgpAfter);
  });
}

function baseConfig(): LiveReservesConfig {
  return {
    adapter: "hive-hbd-protocol",
    version: 1,
    semantics: "protocol-reserve",
    inputs: {
      primary: { kind: "http-json", url: PRIMARY_URL },
      fallbacks: [{ kind: "http-json", url: FALLBACK_URL }],
    },
    params: {
      chain: "hive-mainnet",
      hardfork: "hf26-plus",
      treasuryAccount: "hive.fund",
    },
  };
}

async function fetchFixture(config = baseConfig()) {
  return fetchHiveHbdProtocolReserves(
    {} as never,
    config,
    new AbortController().signal,
    { nowSec: NOW_SEC },
  );
}

describe("hive-hbd-protocol adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRpcFixtures();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("accepts a bracketed two-node agreement and emits the reviewed protocol slice", async () => {
    const output = await fetchFixture();

    expect(output.slices).toEqual([
      expect.objectContaining({
        name: "Hive protocol HIVE conversion mechanism (endogenous HIVE value)",
        pct: 100,
        risk: "high",
      }),
    ]);
    expect(output.slices[0]).not.toHaveProperty("coinId");
    expect(output.metadata).toMatchObject({ freshnessMode: "not-applicable" });
    expect(output.metadata).not.toHaveProperty("sourceTimestamp");
    expect(output.metadata).not.toHaveProperty("collateralizationRatio");
    expect(output.metadata).not.toHaveProperty("totalReserveUsd");
    expect(output.metadata).not.toHaveProperty("supplyUsd");
    expect(output.metadata).not.toHaveProperty("redemption");
    expect(output.metadata?.details).toMatchObject({
      treasuryAccount: "hive.fund",
      thresholdState: "print-stop",
      protocolDebtRatioPct: expect.closeTo(28.31, 2),
    });
    expect(output.warnings).toContainEqual(expect.objectContaining({
      code: "hbd-print-stop-active",
      effect: "info",
    }));

    expect(rpc.fetchJsonPostWithRetry).toHaveBeenCalledTimes(6);
    const logicalMethods = rpc.fetchJsonPostWithRetry.mock.calls.flatMap(([, body]) =>
      Array.isArray(body)
        ? (body as Array<{ method: string }>).map((request) => request.method)
        : [(body as { method: string }).method],
    );
    expect(logicalMethods).toHaveLength(8);
    expect(logicalMethods).not.toContain("condenser_api.get_config");
  });

  it("rejects disagreement in a material feed input", async () => {
    installRpcFixtures({
      fallback: { feed: { ...baseFeed(), current_median_history: { base: "0.041 HBD", quote: "1.000 HIVE" } } },
    });

    await expect(fetchFixture()).rejects.toThrow("nodes disagree on material Hive state");
    expect(rpc.fetchJsonPostWithRetry).toHaveBeenCalledTimes(12);
  });

  it("rejects a changing head across the material read bracket", async () => {
    installRpcFixtures({
      primary: { dgpAfter: baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") },
    });

    await expect(fetchFixture()).rejects.toThrow("crossed a changing Hive head");
    expect(rpc.fetchJsonPostWithRetry).toHaveBeenCalledTimes(12);
  });

  it.each([PRIMARY_URL, `${PRIMARY_URL}/`, "https://API.HIVE.BLOG./other-rpc"])(
    "rejects duplicate node hosts before fetching: %s",
    async (url) => {
      const config = baseConfig();
      config.inputs.fallbacks = [{ kind: "http-json", url }];
      await expect(fetchFixture(config)).rejects.toThrow("two distinct Hive node hosts");
      expect(rpc.fetchJsonPostWithRetry).not.toHaveBeenCalled();
    },
  );

  it("resamples the whole pair through real request caching and I/O limiting after head progression", async () => {
    const { fetchJsonPostWithRetry } = await vi.importActual<typeof import("../request")>("../request");
    const transport = await import("../../../lib/fetch-retry");
    const fixtureRpc = rpc.fetchJsonPostWithRetry.getMockImplementation()!;
    let requests = 0;
    let active = 0;
    let maxActive = 0;
    const completedBrackets: string[] = [];
    const fetchText = vi.spyOn(transport, "fetchTextWithRetry").mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      requests += 1;
      if (requests === 7) expect(completedBrackets).toHaveLength(2);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      let payload = await fixtureRpc(url, body);
      if (!Array.isArray(body) && body.id === 4) {
        if (url === PRIMARY_URL && completedBrackets.length < 2) {
          payload = rpcResult(4, baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
        }
        completedBrackets.push(String(url));
      }
      active -= 1;
      return { body: JSON.stringify(payload), response: new Response() };
    });
    rpc.fetchJsonPostWithRetry.mockImplementation(fetchJsonPostWithRetry);
    const requestCache = new Map<string, Promise<unknown>>();
    const result = await fetchHiveHbdProtocolReserves({} as never, baseConfig(), new AbortController().signal, {
      nowSec: NOW_SEC,
      requestCache,
      ioLimiter: createAdapterIoLimiter(2),
    });

    expect(result.metadata?.details).toMatchObject({ sourceNodes: [PRIMARY_URL, FALLBACK_URL] });
    expect(fetchText).toHaveBeenCalledTimes(12);
    expect(maxActive).toBe(2);
    expect(active).toBe(0);
    expect(requestCache.size).toBe(0);
  });

  it("resamples transient cross-node head skew without accepting different heads", async () => {
    const fixtureRpc = rpc.fetchJsonPostWithRetry.getMockImplementation()!;
    let reads = 0;
    rpc.fetchJsonPostWithRetry.mockImplementation(async (url, body) => {
      reads += 1;
      if (reads <= 6 && url === FALLBACK_URL && !Array.isArray(body)) {
        return rpcResult(body.id, baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
      }
      return fixtureRpc(url, body);
    });
    const result = await fetchFixture();
    expect(result.metadata?.details).toMatchObject({ headBlockId: PRIMARY_HEAD_ID });
    expect(rpc.fetchJsonPostWithRetry).toHaveBeenCalledTimes(12);
  });

  it("does not reset the 19-second budget when resampling", async () => {
    vi.useFakeTimers();
    const fixtureRpc = rpc.fetchJsonPostWithRetry.getMockImplementation()!;
    let reads = 0;
    rpc.fetchJsonPostWithRetry.mockImplementation(async (url, body, signal: AbortSignal) => {
      reads += 1;
      if (reads > 6) {
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      if (!Array.isArray(body) && body.id === 4) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return rpcResult(4, baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));
      }
      return fixtureRpc(url, body);
    });
    const pending = expect(fetchFixture()).rejects.toThrow("attempt budget exceeded");
    await vi.advanceTimersByTimeAsync(19_000);
    await pending;
    expect(rpc.fetchJsonPostWithRetry).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed feed payloads", async () => {
    installRpcFixtures({
      primary: { feed: { current_median_history: { base: "0.040 HIVE", quote: "1.000 HBD" } } },
    });

    await expect(fetchFixture()).rejects.toThrow("invalid HBD asset format");
  });

  it("rejects stale DGP head time", async () => {
    installRpcFixtures({
      primary: { dgpBefore: baseDgp(PRIMARY_HEAD_ID, hiveTime(NOW_SEC - 1_801)), dgpAfter: baseDgp(PRIMARY_HEAD_ID, hiveTime(NOW_SEC - 1_801)) },
      fallback: { dgpBefore: baseDgp(FALLBACK_HEAD_ID, hiveTime(NOW_SEC - 1_801)), dgpAfter: baseDgp(FALLBACK_HEAD_ID, hiveTime(NOW_SEC - 1_801)) },
    });

    await expect(fetchFixture()).rejects.toThrow("head time is stale");
  });

  it("rejects treasury arithmetic that would make counted debt negative", async () => {
    const account = { ...baseAccount(), hbd_balance: "40000000.000 HBD" };
    installRpcFixtures({ primary: { account }, fallback: { account } });

    await expect(fetchFixture()).rejects.toThrow("treasury HBD exceeds current HBD supply");
  });

  it("keeps hard-limit state visible as degraded without clamping the ratio", async () => {
    const feed = { ...baseFeed(), current_median_history: { base: "0.030 HBD", quote: "1.000 HIVE" } };
    installRpcFixtures({ primary: { feed }, fallback: { feed } });

    const output = await fetchFixture();

    expect(output.metadata?.details).toMatchObject({ thresholdState: "hard-limit" });
    expect(output.metadata?.details).toMatchObject({ protocolDebtRatioPct: expect.any(Number) });
    expect(output.warnings).toContainEqual(expect.objectContaining({
      code: "hbd-hard-limit-reached",
      effect: "degraded",
    }));
  });
});
