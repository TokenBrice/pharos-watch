import { afterEach, describe, expect, it, vi } from "vitest";
import type { EvmRpcOptions } from "../../../lib/evm-rpc";
import { expectRecentPinRouting } from "../../../test-helpers/recent-pin-routing";
import { readStateWithPlan, type ExecutableRedemptionReadClient } from "../executable-redemption-read-client";
import { uint256Observation } from "../evm-observation-plan";

const address = "0x0000000000000000000000000000000000000001";
const header = { number: 100, timestamp: 1790000000, hash: `0x${"a".repeat(64)}` as `0x${string}` };
const fields = [uint256Observation({ label: "capacity", contract: address, data: "0x18160ddd" })] as const;

afterEach(() => vi.restoreAllMocks());
describe("executable redemption read plan pin propagation", () => {
  it.each([true, false])("preserves authenticated metadata without fabricating it: %s", async authenticated => {
    const options: EvmRpcOptions = authenticated ? {
      recentStatePin: { chainId: "bsc", header, finalized: header, observedAtSec: header.timestamp + 60, maxAgeSec: 1800 },
      observedHeadBlock: header.number,
    } : {};
    const codeHash = vi.fn().mockResolvedValue("runtime-hash");
    const multicall = vi.fn().mockResolvedValue([{ label: "capacity", success: true, returnData: `0x${"1".padStart(64, "0")}` }]);
    const client: ExecutableRedemptionReadClient = {
      blockNumber: vi.fn(), blockTimestamp: vi.fn(), codeHash, storage: vi.fn(), multicall,
    };
    const snapshot = await readStateWithPlan("asset", "state", fields,
      [{ address, codeHash: "runtime-hash" }], header.number, options, client, undefined, new AbortController().signal);
    expect(snapshot.values.capacity).toBe(1n);
    expect(codeHash).toHaveBeenCalledWith(address, header.number, options);
    expect(multicall.mock.calls[0][2]).toBe(options);
    if (authenticated) await expectRecentPinRouting(options);
    else expect(options).not.toHaveProperty("recentStatePin");
  });
});
