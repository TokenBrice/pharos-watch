import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    probeTrackedTokenSupply: vi.fn(),
    makeOnchainCallers: vi.fn(),
  };
});

vi.mock("@shared/lib/redemption-backstop-configs", () => ({
  REDEMPTION_BACKSTOP_CONFIGS: {
    "coin-with-open-route": { routeStatus: "open" },
    "coin-with-unknown-route": { routeStatus: "unknown" },
    "coin-without-route": {},
  },
}));

import { fetchCuratedValidatedReserves } from "../curated-validated";
import { makeOnchainCallers, probeTrackedTokenSupply } from "../helpers";

import { TEST_SIGNAL as signal } from "./reserve-adapter.test-support";

function makeCoin(
  reserves?: ReserveSlice[],
  contracts?: Array<{ chain: string; address: string }>,
  id = "test-coin",
): StablecoinMeta {
  return { id, name: "Test", ticker: "TST", reserves, contracts } as unknown as StablecoinMeta;
}

const BASE_CONFIG: LiveReservesConfig = {
  adapter: "curated-validated",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" } },
};

const MULTI_SLICE_RESERVES: ReserveSlice[] = [
  { name: "U.S. Treasury bills", pct: 60, risk: "very-low" },
  { name: "Cash deposits", pct: 25, risk: "very-low" },
  { name: "USDC", pct: 15, risk: "low", coinId: "usdc-circle", depType: "wrapper" },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchCuratedValidatedReserves", () => {
  it("returns coin.reserves as slices when probe succeeds", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1000000n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }]),
      BASE_CONFIG,
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.totalSupplyRaw).toBe("1000000");
  });

  it("passes scheduled chain RPC context through to the supply probe", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1000000n);
    const adapterContext = { chainRpcs: new Map() };
    const config: LiveReservesConfig = {
      ...BASE_CONFIG,
      inputs: { primary: { kind: "onchain-solana" } },
    };
    const coin = makeCoin(MULTI_SLICE_RESERVES, [{ chain: "solana", address: "Mint123" }]);

    await fetchCuratedValidatedReserves(coin, config, signal, adapterContext);

    expect(probeTrackedTokenSupply).toHaveBeenCalledWith(
      coin,
      config.inputs.primary,
      signal,
      "curated-validated",
      adapterContext,
      undefined,
      undefined,
    );
  });

  it("preserves coinId and depType from curated reserves", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(500n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0xABCD" }]),
      BASE_CONFIG,
      signal,
    );

    const usdcSlice = result.slices.find((s) => s.name === "USDC");
    expect(usdcSlice?.coinId).toBe("usdc-circle");
    expect(usdcSlice?.depType).toBe("wrapper");
  });

  it("throws when coin.reserves is empty", async () => {
    await expect(
      fetchCuratedValidatedReserves(
        makeCoin([], [{ chain: "ethereum", address: "0x1234" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("coin.reserves to be defined and non-empty");
  });

  it("throws when coin.reserves is undefined", async () => {
    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(undefined, [{ chain: "ethereum", address: "0x1234" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("coin.reserves to be defined and non-empty");
  });

  it("throws when on-chain probe fails", async () => {
    vi.mocked(probeTrackedTokenSupply).mockRejectedValue(
      new Error("curated-validated totalSupply probe failed for test-coin"),
    );

    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("totalSupply probe failed");
  });

  it("throws when probe cannot find contract", async () => {
    vi.mocked(probeTrackedTokenSupply).mockRejectedValue(
      new Error("curated-validated could not find a ethereum contract for test-coin"),
    );

    await expect(
      fetchCuratedValidatedReserves(
        makeCoin(MULTI_SLICE_RESERVES, [{ chain: "arbitrum", address: "0xABCD" }]),
        BASE_CONFIG,
        signal,
      ),
    ).rejects.toThrow("could not find a ethereum contract");
  });

  it("supports non-EVM onchain probe paths when the helper resolves supply", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(42n);

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "solana", address: "Mint1111111111111111111111111111111111" }]),
      {
        ...BASE_CONFIG,
        inputs: {
          primary: { kind: "onchain-solana" },
        },
      },
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.totalSupplyRaw).toBe("42");
  });

  it("derives routeStatus 'open' from the coin's redemption-backstop config", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }], "coin-with-open-route"),
      BASE_CONFIG,
      signal,
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string; routeStatusSource?: string };
    expect(redemption.routeStatus).toBe("open");
    expect(redemption.routeStatusSource).toBe("static-config");
  });

  it("falls back to routeStatus 'unknown' when the coin has no backstop config", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }], "coin-unmapped"),
      BASE_CONFIG,
      signal,
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string };
    expect(redemption.routeStatus).toBe("unknown");
  });

  it("falls back to routeStatus 'unknown' when the backstop config does not specify one", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }], "coin-without-route"),
      BASE_CONFIG,
      signal,
    );
    const redemption = result.metadata?.redemption as { routeStatus?: string };
    expect(redemption.routeStatus).toBe("unknown");
  });

  it("never opens an on-chain call for a coin without redemptionCapacity params", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "ethereum", address: "0x1234" }], "coin-with-open-route"),
      BASE_CONFIG,
      signal,
    );
    expect(makeOnchainCallers).not.toHaveBeenCalled();
    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "documented-eventual",
      routeStatusSource: "static-config",
    });
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
  });
});

// DOC-shaped fixture: MoCState.freeDoc() gated on MoCState.connector() and
// connector.docToken(), with MoC.paused() as the pause surface.
const MOC_STATE = "0xb9C42EFc8ec54490a37cA91c423F7285Fa01e257";
const MOC_CONNECTOR = "0xce2A128cc73E5D98355aAFb2595647F2d3171faA";
const DOC_TOKEN = "0xe700691dA7b9851F2F35f8b8182c69c53CcaD9Db";
const MOC = "0xf773B590aF754D597770937Fa8ea7AbDf2668370";

const PROBE_CONFIG: LiveReservesConfig = {
  ...BASE_CONFIG,
  inputs: { primary: { kind: "onchain-evm", chain: "rootstock", rpcMode: "public-rpc" } },
  params: {
    rpcUrl: "https://public-node.rsk.co",
    redemptionCapacity: {
      chain: "rootstock",
      capacityRead: { kind: "selector", contract: MOC_STATE, selector: "0xa8ba1d18" },
      identityChecks: [
        { contract: MOC_STATE, selector: "0x83f3084f", expectedAddress: MOC_CONNECTOR },
        { contract: MOC_CONNECTOR, selector: "0x99c6fe73", expectedAddress: DOC_TOKEN },
      ],
      pauseCheck: { contract: MOC, selector: "0x5c975abb" },
      decimals: 18,
      holderEligibility: "any-holder",
      sourceUrls: ["https://docs.moneyonchain.com/"],
    },
  },
};

function addressWord(address: string): string {
  return `0x${address.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`;
}

function boolWord(value: boolean): string {
  return `0x${(value ? 1 : 0).toString(16).padStart(64, "0")}`;
}

function mockProbeCallers(overrides: {
  connector?: string | null;
  docToken?: string | null;
  freeDoc?: bigint | null;
  paused?: string | null;
}): void {
  vi.mocked(makeOnchainCallers).mockReturnValue({
    raw: vi.fn(async (contract: string, data: string) => {
      if (data === "0x83f3084f") return overrides.connector === null ? null : addressWord(overrides.connector ?? MOC_CONNECTOR);
      if (data === "0x99c6fe73") return overrides.docToken === null ? null : addressWord(overrides.docToken ?? DOC_TOKEN);
      if (data === "0x5c975abb") return overrides.paused === undefined ? boolWord(false) : overrides.paused;
      throw new Error(`unexpected raw call ${contract} ${data}`);
    }),
    uint256: vi.fn(async () => (overrides.freeDoc === undefined ? 2_874_833n * 10n ** 18n : overrides.freeDoc)),
  });
}

describe("fetchCuratedValidatedReserves redemption probe", () => {
  it("emits live-direct capacity when the identity gate and capacity read both pass", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    mockProbeCallers({});

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "rootstock", address: DOC_TOKEN }], "coin-with-open-route"),
      PROBE_CONFIG,
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 2_874_833,
      capacityKind: "live-direct",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "onchain",
      holderEligibility: "any-holder",
      settlementDelaySec: 0,
      sourceUrls: ["https://docs.moneyonchain.com/"],
    });
  });

  it("withholds the live block and keeps the curated slices when the capacity read fails", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    mockProbeCallers({ freeDoc: null });

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "rootstock", address: DOC_TOKEN }], "coin-with-open-route"),
      PROBE_CONFIG,
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.redemption).toEqual({
      capacityKind: "documented-eventual",
      freshnessKind: "same-run-onchain",
      routeStatus: "open",
      routeStatusSource: "static-config",
    });
    expect(result.warnings?.[0]?.code).toBe("curated-redemption-capacity-unreadable");
  });

  it("withholds the live block when a pinned identity no longer matches", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    mockProbeCallers({ docToken: "0x1111111111111111111111111111111111111111" });

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "rootstock", address: DOC_TOKEN }], "coin-with-open-route"),
      PROBE_CONFIG,
      signal,
    );

    expect(result.slices).toEqual(MULTI_SLICE_RESERVES);
    expect(result.metadata?.redemption).not.toHaveProperty("capacityUsd");
    expect(result.metadata?.redemption).toMatchObject({ routeStatusSource: "static-config" });
  });

  it("reports the route as paused when the pinned pause getter is true", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    mockProbeCallers({ paused: boolWord(true) });

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "rootstock", address: DOC_TOKEN }], "coin-with-open-route"),
      PROBE_CONFIG,
      signal,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityKind: "live-direct",
      routeStatus: "paused",
      routeStatusSource: "onchain",
    });
  });

  it("does not assert openness from a measured zero capacity", async () => {
    vi.mocked(probeTrackedTokenSupply).mockResolvedValue(1n);
    mockProbeCallers({ freeDoc: 0n });

    const result = await fetchCuratedValidatedReserves(
      makeCoin(MULTI_SLICE_RESERVES, [{ chain: "rootstock", address: DOC_TOKEN }], "coin-with-unknown-route"),
      PROBE_CONFIG,
      signal,
    );

    expect(result.metadata?.redemption).toMatchObject({
      capacityUsd: 0,
      capacityKind: "live-direct",
      routeStatus: "unknown",
      routeStatusSource: "static-config",
    });
  });
});
