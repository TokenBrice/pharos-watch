import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { fetchHiveHbdProtocolReserves } from "../hive-hbd-protocol";

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
  });

  it("rejects a changing head across the material read bracket", async () => {
    installRpcFixtures({
      primary: { dgpAfter: baseDgp("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb") },
    });

    await expect(fetchFixture()).rejects.toThrow("crossed a changing Hive head");
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
