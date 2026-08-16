import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "../../../test-helpers/__shared/mock-fetch";
import {
  fetchEvmTokenBalance,
  fetchEvmTokenCurrentBalance,
  fetchTronTokenCurrentBalance,
} from "../../../lib/blacklist/balance-providers";
import type { ContractEventConfig } from "../../../lib/blacklist-contracts";
import { createBudget } from "../../../lib/evm-logs";

const ethereumConfig: ContractEventConfig = {
  configKey: "ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7",
  chain: {
    chainId: "ethereum",
    chainName: "Ethereum",
    evmChainId: 1,
    explorerUrl: "https://etherscan.io",
    type: "evm",
  },
  stablecoinId: "usdt-tether",
  stablecoin: "USDT",
  contractAddress: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
  decimals: 6,
  events: [],
};

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

  it("tries dRPC before Etherscan for the current-balance snapshot when configured", async () => {
    const fetchMock = mockFetch([{ match: () => true, body: { result: null } }]);

    await fetchEvmTokenCurrentBalance(
      ethereumConfig,
      "0x0000000000000000000000000000000000000abc",
      null, // no etherscan key
      "test-drpc-key",
      async (fn) => fn(),
      createBudget(10),
    );

    expect(fetchMock.getHistory().some(({ url }) => url.includes("drpc.org") && url.includes("ethereum"))).toBe(true);
  });
});

describe("fetchEvmTokenBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("tries dRPC and chain-RPC before Etherscan for Ethereum mainnet", async () => {
    const fetchMock = mockFetch([{ match: () => true, body: { result: null } }]);

    await fetchEvmTokenBalance(
      ethereumConfig,
      "0x0000000000000000000000000000000000000abc",
      19000000,
      null, // no etherscan key
      "test-drpc-key",
      async (fn) => fn(),
      createBudget(10),
    );

    // dRPC should have been tried for Ethereum mainnet
    expect(fetchMock.getHistory().some(({ url }) => url.includes("drpc.org") && url.includes("ethereum"))).toBe(true);
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
