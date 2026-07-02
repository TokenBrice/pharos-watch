import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterContext } from "../types";

const evmRpcMocks = vi.hoisted(() => ({
  fetchEtherscanUint256AtBlock: vi.fn(),
  fetchEvmMulticall3Aggregate3AtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
  fetchEtherscanProxyHex: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", () => evmRpcMocks);

import { fetchEvmCallHexAtBlock, fetchEvmUint256AtBlock } from "../../../lib/evm-rpc";
import { makeOnchainCallers } from "../helpers";

describe("makeOnchainCallers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds shared on-chain call options for uint256 and raw calls", async () => {
    const signal = new AbortController().signal;
    const chainRpcs = new Map();
    const ctx = { chainRpcs } as AdapterContext;

    vi.mocked(fetchEvmUint256AtBlock).mockResolvedValueOnce(123n);
    vi.mocked(fetchEvmCallHexAtBlock).mockResolvedValueOnce("0xabcdef");

    const callers = makeOnchainCallers(
      { chain: "base", rpcMode: "public-rpc" },
      {
        signal,
        ctx,
        rpcUrl: "https://primary.example",
        fallbackRpcUrl: "https://fallback.example",
        timeoutMs: 1234,
      },
    );

    await expect(callers.uint256("0x1111111111111111111111111111111111111111", "0x12345678")).resolves.toBe(123n);
    await expect(callers.raw("0x2222222222222222222222222222222222222222", "0x90abcdef")).resolves.toBe(
      "0xabcdef",
    );

    const expectedRpcOptions = {
      extraRpcUrls: ["https://primary.example", "https://fallback.example"],
      signal,
      timeoutMs: 1234,
      chainRpcs,
    };
    expect(fetchEvmUint256AtBlock).toHaveBeenCalledWith(
      "base",
      "0x1111111111111111111111111111111111111111",
      "0x12345678",
      "latest",
      expectedRpcOptions,
    );
    expect(fetchEvmCallHexAtBlock).toHaveBeenCalledWith(
      "base",
      "0x2222222222222222222222222222222222222222",
      "0x90abcdef",
      "latest",
      expectedRpcOptions,
    );
  });
});
