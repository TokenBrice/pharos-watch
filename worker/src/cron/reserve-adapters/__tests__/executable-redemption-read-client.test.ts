import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecutableRedemptionReadClient } from "../executable-redemption-read-client";
import { readStateWithPlan } from "../executable-redemption-read-client";
import { EvmCodeIdentityError } from "../../../lib/evm-code-identity-error";
import { uint256Observation } from "../evm-observation-plan";
import { EIP1967_IMPLEMENTATION_SLOT } from "../onchain-identity";
import type { EvmRpcOptions } from "../../../lib/evm-rpc";
import { expectRecentPinRouting } from "../../../test-helpers/recent-pin-routing";

const address = "0x0000000000000000000000000000000000000001";
const header = { number: 100, timestamp: 1790000000, hash: `0x${"a".repeat(64)}` as `0x${string}` };
const routingFields = [uint256Observation({ label: "capacity", contract: address, data: "0x18160ddd" })] as const;

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
    const snapshot = await readStateWithPlan("asset", "state", routingFields,
      [{ address, codeHash: "runtime-hash" }], header.number, options, client, undefined, new AbortController().signal);
    expect(snapshot.values.capacity).toBe(1n);
    expect(codeHash).toHaveBeenCalledWith(address, header.number, options);
    expect(multicall.mock.calls[0][2]).toBe(options);
    if (authenticated) await expectRecentPinRouting(options);
    else expect(options).not.toHaveProperty("recentStatePin");
  });
});

const PROXY = `0x${"1".repeat(40)}`;
const IMPLEMENTATION = `0x${"2".repeat(40)}`;
const CODE_HASH = `0x${"a".repeat(64)}`;
const IMPLEMENTATION_HASH = `0x${"b".repeat(64)}`;
const BLOCK = 26_224_349;
const WORD = `0x${IMPLEMENTATION.slice(2).padStart(64, "0")}` as const;
const fields = [uint256Observation({ label: "capacity", contract: PROXY, data: "0x12345678" })] as const;
const identities = [{ address: PROXY, codeHash: CODE_HASH, implementationAddress: IMPLEMENTATION, implementationCodeHash: IMPLEMENTATION_HASH }];

function client(): ExecutableRedemptionReadClient {
  return {
    blockNumber: vi.fn(), blockTimestamp: vi.fn(),
    codeHash: vi.fn(async (address) => address === PROXY ? CODE_HASH : IMPLEMENTATION_HASH),
    storage: vi.fn(async () => WORD),
    multicall: vi.fn(async () => [{ label: "capacity", success: true, returnData: `0x${"1".padStart(64, "0")}` as const }]),
  };
}

function observe(readClient: ExecutableRedemptionReadClient, rpcOptions = {}) {
  return readStateWithPlan("usdfr-forest-road", "route-state", fields, identities, BLOCK, rpcOptions, readClient, undefined, new AbortController().signal);
}

describe("executable identity failure propagation", () => {
  it.each([
    ["code-unavailable", "contract", null, WORD, IMPLEMENTATION_HASH],
    ["implementation-unavailable", "storage", CODE_HASH, null, IMPLEMENTATION_HASH],
    ["implementation-unavailable", "storage", CODE_HASH, "0x1234", IMPLEMENTATION_HASH],
    ["code-drift", "contract", IMPLEMENTATION_HASH, WORD, IMPLEMENTATION_HASH],
    ["implementation-drift", "storage", CODE_HASH, `0x${"3".repeat(64)}`, IMPLEMENTATION_HASH],
    ["implementation-drift", "implementation", CODE_HASH, WORD, CODE_HASH],
    ["code-unavailable", "implementation", CODE_HASH, WORD, null],
  ] as const)("preserves %s for %s and withholds route state", async (rejectionCode, kind, proxyCode, slot, implementationCode) => {
    const readClient = client();
    readClient.codeHash = vi.fn(async (address) => address === PROXY ? proxyCode : implementationCode);
    readClient.storage = vi.fn(async () => slot);
    const error = await observe(readClient).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(EvmCodeIdentityError);
    expect(error).toMatchObject({ rejectionCode });
    expect((error as Error).message).toContain(`(${kind}, block ${BLOCK})`);
    expect((error as Error).message).toContain(rejectionCode.endsWith("unavailable") ? "unavailable" : "observed mismatch");
    expect(readClient.multicall).not.toHaveBeenCalled();
  });

  it("keeps bytecode, implementation slot and route state at one exact block/options", async () => {
    const readClient = client();
    const rpcOptions = { extraRpcUrls: ["https://rpc.example"], timeoutMs: 5_000 };
    const result = await observe(readClient, rpcOptions);
    expect(result.values.capacity).toBe(1n);
    expect(readClient.codeHash).toHaveBeenNthCalledWith(1, PROXY, BLOCK, rpcOptions);
    expect(readClient.codeHash).toHaveBeenNthCalledWith(2, IMPLEMENTATION, BLOCK, rpcOptions);
    expect(readClient.storage).toHaveBeenCalledWith(PROXY, EIP1967_IMPLEMENTATION_SLOT, BLOCK, rpcOptions);
    expect(readClient.multicall).toHaveBeenCalledWith(expect.any(Array), BLOCK, rpcOptions);
    expect(readClient.blockNumber).not.toHaveBeenCalled();
    expect(readClient.blockTimestamp).not.toHaveBeenCalled();
  });
});
