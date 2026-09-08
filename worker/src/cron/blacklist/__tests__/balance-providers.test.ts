import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import {
  fetchEvmTokenBalance,
  fetchEvmTokenCurrentBalance,
  fetchTronTokenCurrentBalance,
} from "../../../lib/blacklist/balance-providers";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import { createBudget } from "../../../lib/evm-logs";

import { ethereumConfig } from "./balance.test-support";

const tronConfig: ContractEventConfig = {
  configKey: "tron-tr7nhqjekqxgtci8q8zy4pl8otszgjlj6t",
  chain: {
    chainId: "tron",
    chainName: "Tron",
    evmChainId: null,
    explorerUrl: "https://tronscan.org",
    type: "tron",
  },
  stablecoinId: "usdt-tether",
  stablecoin: "USDT",
  contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  decimals: 6,
  events: [],
};

describe("fetchTronTokenCurrentBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts the configured token balance from the Tron account payload", async () => {
    mockFetch([{
      match: "api.trongrid.io",
      body: {
        data: [
          {
            trc20: [
              { TXYZ: "1" },
              { [tronConfig.contractAddress]: "50000003770001" },
            ],
          },
        ],
      },
    }]);

    const amount = await fetchTronTokenCurrentBalance(
      tronConfig,
      "0x2004662f694f30fd269e4cccba222654b5f0538b",
      null,
      async (fn) => fn(),
      createBudget(10),
    );

    expect(amount).toBe(50_000_003.770001);
  });

  it("returns null when the account has no tracked token balance entry", async () => {
    mockFetch([{
      match: "api.trongrid.io",
      body: { data: [{ trc20: [{ TXYZ: "1" }] }] },
    }]);

    const amount = await fetchTronTokenCurrentBalance(
      tronConfig,
      "TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2Aa",
      null,
      async (fn) => fn(),
      createBudget(10),
    );

    expect(amount).toBeNull();
  });
});

describe("fetchEvmTokenCurrentBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the latest balance via the Etherscan proxy path", async () => {
    mockFetch([{
      match: "etherscan.io",
      body: {
        status: "1",
        message: "OK",
        result: "0x0000000000000000000000000000000000000000000000000000000002faf080",
      },
    }]);

    const amount = await fetchEvmTokenCurrentBalance(
      ethereumConfig,
      "0x0000000000000000000000000000000000000abc",
      "test-key",
      null, // no dRPC
      async (fn) => fn(),
      createBudget(10),
    );

    expect(amount).toBe(50);
  });

  it("selects dRPC before configured chain RPC and Etherscan for current balances", async () => {
    const fetchMock = mockFetch([
      { match: "drpc.org", body: { result: "0x0f4240" } },
      { match: "chain-rpc.test", body: { result: "0x1e8480" } },
      { match: "etherscan.io", body: { result: "0x2dc6c0" } },
    ], { requireMatch: true });
    const amount = await fetchEvmTokenCurrentBalance(
      ethereumConfig, "0x0000000000000000000000000000000000000abc",
      "etherscan-key", "drpc-key", async (fn) => fn(), createBudget(10), undefined,
      new Map([["ethereum", { ...ethereumConfig.chain, rpcUrl: "https://chain-rpc.test" }]]),
    );
    expect(amount).toBe(1);
    expect(fetchMock.getHistory()).toHaveLength(1);
    expect(fetchMock.getHistory()[0].url).toContain("drpc.org");
    expect(JSON.parse(fetchMock.getHistory()[0].body!).params[1]).toBe("latest");
  });
});

describe("fetchEvmTokenBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([0, 1, 2])("selects the first successful historical provider after %i failures", async (failures) => {
    const fetchMock = mockFetch([
      { match: "drpc.org", body: { result: failures > 0 ? null : "0x0f4240" } },
      { match: "chain-rpc.test", body: { result: failures > 1 ? null : "0x1e8480" } },
      { match: "etherscan.io", body: { result: "0x2dc6c0" } },
    ], { requireMatch: true });
    const amount = await fetchEvmTokenBalance(
      ethereumConfig, "0x0000000000000000000000000000000000000abc", 19000000,
      "etherscan-key", "drpc-key", async (fn) => fn(), createBudget(10), undefined,
      new Map([["ethereum", { ...ethereumConfig.chain, rpcUrl: "https://chain-rpc.test" }]]),
    );
    expect(amount).toBe(failures + 1);
    const history = fetchMock.getHistory();
    expect(history.map(({ url }) => new URL(url).hostname)).toEqual(
      ["lb.drpc.org", "chain-rpc.test", "api.etherscan.io"].slice(0, failures + 1),
    );
    for (const request of history) {
      expect(request.body ? JSON.parse(request.body).params[1] : new URL(request.url).searchParams.get("tag"))
        .toBe("0x121eac0");
    }
  });

  it("returns null when block number produces an invalid hex tag", async () => {
    mockFetch([{
      match: () => true,
      body: { status: "1", message: "OK", result: "0x02faf080" },
    }]);

    const amount = await fetchEvmTokenBalance(
      ethereumConfig,
      "0x0000000000000000000000000000000000000abc",
      -1, // produces blockTag "0x-1" -> parseInt("0x-1", 16) = NaN in fetchEvmBalanceAtTag
      "test-key",
      null, // no dRPC
      async (fn) => fn(),
      createBudget(10),
    );

    // Must be null — not a balance from "latest" block
    expect(amount).toBeNull();
  });
});
