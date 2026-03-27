import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchEvmTokenCurrentBalance,
  fetchTronTokenCurrentBalance,
} from "../balance-providers";
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
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                trc20: [
                  { TXYZ: "1" },
                  { [tronConfig.contractAddress]: "50000003770001" },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )),
    );

    const amount = await fetchTronTokenCurrentBalance(
      tronConfig,
      "0x2004662f694f30fd269e4cccba222654b5f0538b",
      null,
      async (fn) => fn(),
      createBudget(10),
    );

    expect(amount).toBe(50_000_003.770001);
  });

  it("returns zero when the account has no tracked token balance entry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                trc20: [{ TXYZ: "1" }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )),
    );

    const amount = await fetchTronTokenCurrentBalance(
      tronConfig,
      "TCtVtrdy8sSXGMx1QYUjMrAvau1pduC2Aa",
      null,
      async (fn) => fn(),
      createBudget(10),
    );

    expect(amount).toBe(0);
  });
});

describe("fetchEvmTokenCurrentBalance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads the latest balance via the Etherscan proxy path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            status: "1",
            message: "OK",
            result: "0x0000000000000000000000000000000000000000000000000000000002faf080",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )),
    );

    const amount = await fetchEvmTokenCurrentBalance(
      ethereumConfig,
      "0x0000000000000000000000000000000000000abc",
      "test-key",
      async (fn) => fn(),
      createBudget(10),
    );

    expect(amount).toBe(50);
  });
});
