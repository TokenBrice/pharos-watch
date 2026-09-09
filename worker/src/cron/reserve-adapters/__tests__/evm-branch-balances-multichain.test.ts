import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../../../lib/evm-rpc", async (original) => ({
  ...await original<typeof import("../../../lib/evm-rpc")>(),
  fetchEvmBlockNumber: vi.fn(async (chain: string) => chain === "base" ? 200 : 100),
  fetchEvmBlockTimestamp: vi.fn(async () => 1_800_000_000),
}));
vi.mock("../helpers", async (original) => ({
  ...await original<typeof import("../helpers")>(),
  fetchOnchainMulticall3: vi.fn(),
  fetchOnchainUint256: vi.fn(),
  probeOptionalRedemptionRateBps: vi.fn(async () => null),
}));
import { fetchOnchainMulticall3, fetchOnchainUint256 } from "../helpers";
import { fetchEvmBranchBalancesReserves } from "../evm-branch-balances";
import { hasFatalWarnings } from "../validate";

const token = "0x1111111111111111111111111111111111111111";
const holder = "0x2222222222222222222222222222222222222222";
const underlying = "0x3333333333333333333333333333333333333333";
const word = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`;
const branch = (name: string, chain = "optimism") => ({
  name, chain, holder, token: { chain, address: token, decimals: 6 }, risk: "low", priceUsd: 1,
});
const config = (branches: unknown[]): LiveReservesConfig => ({
  adapter: "evm-branch-balances", version: 1, semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "optimism", rpcMode: "public-rpc" } }, params: { branches },
});
const run = (branches: unknown[]) => fetchEvmBranchBalancesReserves(
  TRACKED_META_BY_ID.get("jpyt-dephaser")!, config(branches), new AbortController().signal,
);

beforeEach(() => vi.resetAllMocks());
describe("branch multichain and receipt observations", () => {
  it("aggregates holdings using each chain's pinned block", async () => {
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ chain, ctx, calls }) => {
      expect(ctx?.observedBlock).toMatchObject({ chain, number: chain === "base" ? 200 : 100 });
      return calls.map((call) => ({ label: call.label, success: true, returnData: word(
        call.label.startsWith("branch-decimals") ? 6n : chain === "base" ? 25_000_000n : 75_000_000n,
      ) }));
    });
    const result = await run([branch("USDT"), branch("USDC", "base")]);
    expect(result.slices.map(({ name, pct }) => ({ name, pct }))).toEqual([{ name: "USDT", pct: 75 }, { name: "USDC", pct: 25 }]);
    expect(result.metadata?.details?.observedBlocks).toEqual([
      { chain: "optimism", number: 100, timestamp: 1_800_000_000 },
      { chain: "base", number: 200, timestamp: 1_800_000_000 },
    ]);
  });

  it("converts aggregate cToken claims before pricing and retains the receipt decimals gate", async () => {
    let observedDecimals = 8n;
    const receipt = {
      ...branch("meUSDC"), token: { chain: "optimism", address: token, decimals: 8 },
      priceToken: { chain: "optimism", address: underlying }, receipt: { kind: "compound-v2" },
      balanceRead: { contract: holder, selector: "0xa5fdc5de", args: [word(BigInt(token))] },
    };
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) => calls.map((call) => {
      if (call.label === "branch-balance:0") {
        expect(call.contract).toBe(holder);
        expect(call.data).toBe(`0xa5fdc5de${word(BigInt(token)).slice(2)}`);
      }
      return { label: call.label, success: true, returnData: word(call.label === "branch-decimals:0" ? observedDecimals : call.label === "branch-decimals:1" ? 6n : call.label === "branch-balance:0" ? 100n * 10n ** 8n : 2_327_425n) };
    }));
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) => data === "0x182df0f5" ? 232_742_590_670_167n : data === "0x6f307dc3" ? BigInt(underlying) : 6n);
    const result = await run([receipt, branch("USDC")]);
    expect(result.slices.map(({ pct }) => pct)).toEqual([50, 50]);
    expect(hasFatalWarnings(result.warnings)).toBe(false);
    observedDecimals = 18n;
    const rejected = await run([receipt, branch("USDC")]);
    expect(hasFatalWarnings(rejected.warnings)).toBe(true);
    expect(rejected.warnings).toContainEqual(expect.objectContaining({ code: "branch-token-decimals-mismatch" }));
  });

  it("keeps aggregate decimals checks on individual fallback and rejects receipt identity drift", async () => {
    vi.mocked(fetchOnchainMulticall3).mockResolvedValue(null);
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) => data === "0x313ce567" ? 18n : 1_000_000n);
    const aggregate = { ...branch("USDC"), balanceRead: { contract: holder, selector: "0xa5fdc5de", args: [word(BigInt(token))] } };
    expect(hasFatalWarnings((await run([aggregate])).warnings)).toBe(true);
    await expect(run([{ ...aggregate, receipt: { kind: "compound-v2" }, priceToken: { chain: "optimism", address: underlying } }])).rejects.toThrow("underlying identity");
  });

  it("scales 18-decimal underlying claims and rejects missing conversion rates", async () => {
    const receipt = {
      ...branch("mewETH"), token: { chain: "optimism", address: token, decimals: 8 },
      priceUsd: 2_000, priceToken: { chain: "optimism", address: underlying },
      receipt: { kind: "compound-v2", exchangeRateSelector: "0x12345678" },
    };
    vi.mocked(fetchOnchainMulticall3).mockImplementation(async ({ calls }) => calls.map((call) => ({
      label: call.label, success: true, returnData: word(
        call.label === "branch-decimals:0" ? 8n : call.label === "branch-decimals:1" ? 6n
          : call.label === "branch-balance:0" ? 10n * 10n ** 8n : 100_000_000n,
      ),
    })));
    let rate: bigint | null = 2n * 10n ** 26n;
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) =>
      data === "0x12345678" ? rate : data === "0x6f307dc3" ? BigInt(underlying) : 18n);
    expect((await run([receipt, branch("USDC")])).slices.map(({ pct }) => pct)).toEqual([80, 20]);
    rate = null;
    await expect(run([receipt])).rejects.toThrow("exchange rate unavailable");
  });
});
