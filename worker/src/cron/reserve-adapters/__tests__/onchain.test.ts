import { describe, expect, it, vi } from "vitest";
import type { OnchainRateProbe } from "../onchain";

const evmRpcMocks = vi.hoisted(() => ({
  fetchEtherscanUint256AtBlock: vi.fn(),
  fetchEvmUint256AtBlock: vi.fn(),
}));

vi.mock("../../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/evm-rpc")>();
  return {
    ...actual,
    fetchEtherscanUint256AtBlock: evmRpcMocks.fetchEtherscanUint256AtBlock,
    fetchEvmUint256AtBlock: evmRpcMocks.fetchEvmUint256AtBlock,
  };
});

import { fetchOnchainRateBps } from "../onchain";

describe("fetchOnchainRateBps", () => {
  it("skips a rate probe when decimals are missing", async () => {
    const probe: OnchainRateProbe = {
      contract: "0x0000000000000000000000000000000000000001",
      selector: "0x12345678",
    };

    await expect(
      fetchOnchainRateBps(
        { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
        probe,
        AbortSignal.timeout(5_000),
      ),
    ).resolves.toBeNull();
    expect(evmRpcMocks.fetchEvmUint256AtBlock).not.toHaveBeenCalled();
    expect(evmRpcMocks.fetchEtherscanUint256AtBlock).not.toHaveBeenCalled();
  });
});
