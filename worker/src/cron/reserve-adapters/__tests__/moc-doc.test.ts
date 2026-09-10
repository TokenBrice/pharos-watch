import { describe, expect, it } from "vitest";
import {
  expectWarningEffect,
  expectWarnings,
  installAdapterNetwork,
  runAdapter,
  type AdapterNetworkSpec,
} from "./reserve-adapter.test-support";

const WAD = 10n ** 18n;
const now = 1_800_000_000;
const BLOCK_NUMBER = 0x100;
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const MOC = "0xf773b590af754d597770937fa8ea7abdf2668370";
const STATE = "0xb9c42efc8ec54490a37ca91c423f7285fa01e257";
const CONNECTOR = "0xce2a128cc73e5d98355aafb2595647f2d3171faa";
const DOC = "0xe700691da7b9851f2f35f8b8182c69c53ccad9db";
const ORACLE = "0xe2927a0620b82a66d67f678fc9b826b0e01b1bfd";
const LEGACY_IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function word(value: bigint | number | string): `0x${string}` {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function accounting(collateral = 200n * WAD): string[] {
  const price = 50_000n * WAD;
  const supply = 2_000_000n * WAD;
  const locked = supply * WAD / price;
  return [
    "0x8cf0035b1d1bcd6821f563b3db0530ef59c5d226", "0xf65be577b252a41887e2f1a19b576a0925201186",
    "0x437221b50b0066186e58412b0ba940441a7b7df5", "0xa7e86af8eb19e3dab8e7353cb27d286372aac87d",
    "0xce2a128cc73e5d98355aafb2595647f2d3171faa", "0xf773b590af754d597770937fa8ea7abdf2668370",
    "0xb9c42efc8ec54490a37ca91c423f7285fa01e257", "0xe700691da7b9851f2f35f8b8182c69c53ccad9db",
    "0xe2927a0620b82a66d67f678fc9b826b0e01b1bfd",
    collateral, collateral, collateral, supply, supply, price, 0n, locked,
    collateral > locked ? collateral - locked : 0n, collateral * WAD / locked,
    3, 0, supply, 104n * WAD / 100n, 1, WAD, WAD, 0, 15n * WAD / 10n,
  ].map((value, i) => i === 15 ? `${word(price)}${word(1).slice(2)}${word(250).slice(2)}` : word(value));
}

function mocNetwork(
  values = accounting(),
  blockOverrides: Partial<{ number: number; timestamp: number; hash: string }> = {},
): AdapterNetworkSpec {
  const rpc: Record<string, string | null> = {};
  const key = (method: string, contract: string, data = "") =>
    `${method}:rootstock:${contract}:${data}`;
  const implementations: Array<[string, string]> = [
    [MOC, LEGACY_IMPLEMENTATION_SLOT],
    [STATE, LEGACY_IMPLEMENTATION_SLOT],
    [CONNECTOR, LEGACY_IMPLEMENTATION_SLOT],
    [ORACLE, EIP1967_IMPLEMENTATION_SLOT],
  ];
  implementations.forEach(([contract, slot], index) => {
    rpc[key("eth_getStorageAt", contract, slot)] = values[index]!;
  });
  const calls: Array<[string, string, number]> = [
    [STATE, "0x83f3084f", 4],
    [CONNECTOR, "0x53428253", 5],
    [CONNECTOR, "0x12529f1f", 6],
    [CONNECTOR, "0x99c6fe73", 7],
    [STATE, "0xd298d9c9", 8],
    [STATE, "0x96e4a037", 9],
    [STATE, "0x8bd11355", 10],
    [STATE, "0xdf3d90b3", 12],
    [DOC, "0x18160ddd", 13],
    [STATE, "0x8300df49", 14],
    [ORACLE, "0x330227bf", 15],
    [STATE, "0x118fe752", 16],
    [STATE, "0xc94750a8", 17],
    [STATE, "0xc4ee19ea", 18],
    [STATE, "0xc19d93fb", 19],
    [MOC, "0x5c975abb", 20],
    [STATE, "0xa8ba1d18", 21],
    [STATE, "0x7f19c56f", 22],
    [STATE, "0x9214fa4d", 23],
    [STATE, "0x06bdce8c", 24],
    [STATE, "0xf715e293", 25],
    [STATE, `0x04bda17f${"5832".padEnd(64, "0")}`, 26],
    [STATE, "0xe480e5b9", 27],
  ];
  for (const [contract, data, index] of calls) rpc[key("eth_call", contract, data)] = values[index]!;
  rpc[key("eth_getBalance", MOC)] = values[11]!;
  return {
    chains: { rootstock: "https://public-node.rsk.co" },
    block: {
      number: blockOverrides.number ?? BLOCK_NUMBER,
      timestamp: blockOverrides.timestamp ?? now - 30,
      hash: blockOverrides.hash ?? BLOCK_HASH,
    },
    rpc,
  };
}

function run(values = accounting(), blockOverrides: Partial<{ number: number; timestamp: number; hash: string }> = {}) {
  return runAdapter("moc-doc", "doc-money-on-chain", {
    network: mocNetwork(values, blockOverrides),
    nowSec: now,
  });
}

interface RpcRequestBody {
  method?: unknown;
  params?: unknown[];
}

function rpcRequest(value: unknown): RpcRequestBody | null {
  if (typeof value !== "object" || value === null || !("method" in value)) return null;
  const params = "params" in value && Array.isArray(value.params) ? value.params : undefined;
  return { method: value.method, params };
}

function mutateClosingBlock(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("result" in value)) return value;
  const result = value.result;
  if (typeof result !== "object" || result === null) return value;
  return { ...value, result: { ...result, hash: `0x${"cd".repeat(32)}` } };
}

describe("MoC DOC accounted rBTC", () => {
  it("proves complete canonical collateral and preserves senior DOC/junior BPRO accounting", async () => {
    const { result, network } = await run();
    expect(result.slices).toEqual([{ sourceKey: "moc-doc:rbtc", name: "Rootstock BTC (rBTC) collateral", pct: 100, risk: "medium" }]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable", totalReserveUsd: 10_000_000, supplyUsd: 2_000_000, collateralizationRatio: 5,
      details: { docLockedRbtcRaw: (40n * WAD).toString(), juniorBproResidualRbtcRaw: (160n * WAD).toString() },
      redemption: { capacityUsd: 2_000_000, routeStatus: "open" },
    });
    expectWarnings(result, []);
    expect(network.rpcCalls.every((call) => call.block === "0x100")).toBe(true);
  });

  it("does not count unaccounted rBTC donations as backing", async () => {
    const values = accounting();
    values[11] = word(250n * WAD);
    expect((await run(values)).result.metadata?.totalReserveUsd).toBe(10_000_000);
  });

  it("caps missing custody collateral and degrades rather than hiding insolvency", async () => {
    const values = accounting();
    values[11] = word(20n * WAD);
    const { result } = await run(values);
    expect(result.metadata?.collateralizationRatio).toBe(0.5);
    expectWarnings(result, ["moc-doc-custody-deficit", "reserve-undercollateralized"]);
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "degraded" });
  });

  it("retains a valid undercollateralized state as degraded evidence", async () => {
    const { result } = await run(accounting(20n * WAD));
    expect(result.metadata?.collateralizationRatio).toBe(0.5);
    expect(result.metadata?.details).toMatchObject({ juniorBproResidualRbtcRaw: "0" });
    expectWarningEffect(result, "reserve-undercollateralized", "degraded");
  });

  it.each([
    [0, word(1), "implementation"],
    [7, word(1), "identity"],
    [13, word(WAD), "accounting state"],
    [16, word(1), "reconcile"],
    [26, word(1), "accounting state"],
    [15, `${word(50_000n * WAD)}${word(0).slice(2)}${word(250).slice(2)}`, "oracle"],
  ])("fails closed for invalid read %i", async (index, value, error) => {
    const values = accounting();
    values[index as number] = value;
    await expect(run(values)).rejects.toThrow(String(error));
  });

  it("degrades paused state and withholds executable capacity", async () => {
    const values = accounting();
    values[20] = word(1);
    const { result } = await run(values);
    expectWarnings(result, ["moc-doc-protocol-state"]);
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "paused" });
  });

  it.each([48n * WAD, 60n * WAD])("withholds capacity at or below protection even above liquidation coverage", async (collateral) => {
    const { result } = await run(accounting(collateral));
    expectWarnings(result, ["moc-doc-protection-mode"]);
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 0, routeStatus: "degraded" });
  });

  it("permits capacity strictly above protection coverage", async () => {
    const { result } = await run(accounting(60n * WAD + WAD / 100n));
    expect(result.metadata?.redemption).toMatchObject({ capacityUsd: 2_000_000, routeStatus: "open" });
  });

  it("rejects reorged or stale block evidence", async () => {
    const network = installAdapterNetwork(mocNetwork());
    const baseFetch = network.fetchSpy.getMockImplementation();
    if (!baseFetch) throw new Error("missing harness fetch implementation");
    network.fetchSpy.mockImplementation(async (input, init) => {
      const rawBody = typeof init?.body === "string" ? init.body : null;
      const requestBody = rawBody ? JSON.parse(rawBody) as unknown : null;
      const response = await baseFetch(input, init);
      if (!requestBody) return response;
      const responseBody = await response.clone().json() as unknown;
      const mutate = (entry: unknown, index: number): unknown => {
        const request = rpcRequest(Array.isArray(requestBody) ? requestBody[index] : requestBody);
        if (
          request?.method === "eth_getBlockByNumber"
          && request.params?.[0] === `0x${BLOCK_NUMBER.toString(16)}`
        ) {
          return mutateClosingBlock(entry);
        }
        return entry;
      };
      const mutated = Array.isArray(responseBody)
        ? responseBody.map(mutate)
        : mutate(responseBody, 0);
      return Response.json(mutated);
    });
    await expect(runAdapter("moc-doc", "doc-money-on-chain", { network, nowSec: now }))
      .rejects.toThrow("pinned block changed");
    await expect(run(accounting(), { timestamp: now - 601 })).rejects.toThrow("stale/future");
  });
});
