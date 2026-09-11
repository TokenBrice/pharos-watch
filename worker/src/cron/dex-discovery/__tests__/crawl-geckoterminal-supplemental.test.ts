import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContractDeployment } from "@shared/types/core";
import { sleepWithSignal } from "../../../lib/abort";
import { crawlTokenPools } from "../../dex-liquidity/crawl-helpers";
import { fetchGtTokenPools } from "../../dex-liquidity/geckoterminal-shared";
import type { GtPool } from "../../dex-liquidity/types";
import { crawlGeckoTerminalPoolsStage } from "../crawl-geckoterminal-pools";
import { classifyDexDeploymentOutcomes } from "../deployment-outcomes";
import { createCrawlStageContext } from "../staged-pool";
import type { StagedPool } from "../types";

const STACKS_TOKEN = "SP000000000000000000002Q6VF78.usdh";
afterEach(() => vi.restoreAllMocks());

function context(stablecoinId = "supplemental-fixture") {
  return createCrawlStageContext({
    stablecoinId,
    knownPoolIds: new Set(),
    nowSec: 1_800_000_000,
    pools: [],
    priceObs: [],
  });
}

function target(stablecoinId: string, chain: string): ContractDeployment {
  const addresses: Record<string, string> = {
    "usdy-ondo-finance": "ibc/ABC",
    "usdh-hermetica": STACKS_TOKEN,
    "hchf-hedera-swiss-franc": "0.0.6070123",
    "bnusd-balanced": "factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/inj1qspaxnztkkzahvp6scq6xfpgafejmj2td83r9j",
    "usdc-circle": "0xa00c59ff5a080d2b954d0c75e46e22a0c371235a",
  };
  return { chain, address: addresses[stablecoinId]!, decimals: 6 };
}

describe("supplemental GeckoTerminal deployment discovery", () => {
  it("queries fixed supplemental chain identities without admitting an IBC denom as EVM", async () => {
    const targets: ContractDeployment[] = [
      { chain: "starknet", address: "0xAbC", decimals: 6 },
      { chain: "stacks", address: STACKS_TOKEN, decimals: 6 },
      { chain: "mantra", address: "0xAbCd000000000000000000000000000000000001", decimals: 6 },
    ];
    // The same repo chain id also carries an IBC denom. It must not be sent to
    // MANTRA EVM or admitted as a checked deployment.
    const mantraIbc = target("usdy-ondo-finance", "mantra");
    const fetchPools = vi.fn<typeof fetchGtTokenPools>(async () => []);

    const result = await crawlGeckoTerminalPoolsStage({
      coinTargets: [...targets, mantraIbc],
      cgPriceObservationTargets: new Set(),
      context: context(),
      dependencies: {
        crawlTokenPools,
        fetchGtTokenPools: fetchPools,
        sleepWithSignal: vi.fn<typeof sleepWithSignal>(async () => {}),
      },
    });

    expect(fetchPools).toHaveBeenCalledTimes(3);
    expect(fetchPools.mock.calls.map(([address, network]) => [address, network])).toEqual([
      ["0x0000000000000000000000000000000000000000000000000000000000000abc", "starknet-alpha"],
      [STACKS_TOKEN, "stacks"],
      ["0xabcd000000000000000000000000000000000001", "mantra-evm"],
    ]);
    expect(result.providerChecks).toEqual(
      targets.map((deployment) => ({
        chain: deployment.chain,
        address: deployment.address,
        provider: "geckoterminal",
        status: "success",
      })),
    );
    expect(result.providerChecks).not.toContainEqual(
      expect.objectContaining({ address: mantraIbc.address }),
    );
  });

  it("keeps a provider failure inaccessible instead of certifying a known-empty surface", async () => {
    const deployment = target("usdh-hermetica", "stacks");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stage = await crawlGeckoTerminalPoolsStage({
      coinTargets: [deployment],
      cgPriceObservationTargets: new Set(),
      context: context("usdh-hermetica"),
      dependencies: {
        crawlTokenPools,
        fetchGtTokenPools: vi.fn<typeof fetchGtTokenPools>(async () => {
          throw new Error("provider unavailable");
        }),
        sleepWithSignal: vi.fn<typeof sleepWithSignal>(async () => {}),
      },
    });

    expect(stage.providerChecks).toEqual([
      {
        chain: deployment.chain,
        address: deployment.address,
        provider: "geckoterminal",
        status: "failure",
        retryable: true,
      },
    ]);
    expect(
      classifyDexDeploymentOutcomes({
        stablecoinId: "usdh-hermetica",
        deployments: [deployment],
        pools: [],
        providerChecks: stage.providerChecks,
        nowSec: 1_800_000_000,
      }),
    ).toEqual([
      expect.objectContaining({
        outcome: "provider_inaccessible",
        providers: ["geckoterminal"],
      }),
    ]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("queries fixed Hedera and Injective identities while preserving census keys", async () => {
    const hchf = target("hchf-hedera-swiss-franc", "hedera");
    const bnusd = target("bnusd-balanced", "injective");
    const fetchPools = vi.fn<typeof fetchGtTokenPools>(async () => []);

    const result = await crawlGeckoTerminalPoolsStage({
      coinTargets: [hchf, bnusd],
      cgPriceObservationTargets: new Set(),
      context: context(),
      dependencies: {
        crawlTokenPools,
        fetchGtTokenPools: fetchPools,
        sleepWithSignal: vi.fn<typeof sleepWithSignal>(async () => {}),
      },
    });

    expect(fetchPools.mock.calls.map(([address, network]) => [address, network])).toEqual([
      ["0x00000000000000000000000000000000005c9f6b", "hedera-hashgraph"],
      [
        "factory/inj14ejqjyq8um4p3xfqj74yld5waqljf88f9eneuk/inj1qspaxnztkkzahvp6scq6xfpgafejmj2td83r9j",
        "injective",
      ],
    ]);
    expect(result.providerChecks).toEqual(
      [hchf, bnusd].map((deployment) => ({
        chain: deployment.chain,
        address: deployment.address,
        provider: "geckoterminal",
        status: "success",
      })),
    );
  });

  it("correlates a Hedera long-zero pool token back to its entity-id deployment", async () => {
    const deployment = target("hchf-hedera-swiss-franc", "hedera");
    const pools: StagedPool[] = [];
    const stageContext = createCrawlStageContext({
      stablecoinId: "hchf-hedera-swiss-franc",
      knownPoolIds: new Set(),
      nowSec: 1_800_000_000,
      pools,
      priceObs: [],
    });
    const providerPool: GtPool = {
      id: "hedera-hashgraph_0x3a2a68e8edf6c97b6b6f8fdd4c139f968040cf84",
      type: "pool",
      attributes: {
        address: "0x3a2a68e8edf6c97b6b6f8fdd4c139f968040cf84",
        name: "HCHF / WHBAR",
        pool_created_at: "2024-01-01T00:00:00.000Z",
        base_token_price_usd: "",
        quote_token_price_usd: "",
        reserve_in_usd: "18259",
        volume_usd: { h24: "0" },
      },
      relationships: {
        base_token: {
          data: {
            id: "hedera-hashgraph_0x00000000000000000000000000000000005c9f6b",
            type: "token",
          },
        },
        quote_token: {
          data: {
            id: "hedera-hashgraph_0x0000000000000000000000000000000000163b5a",
            type: "token",
          },
        },
        dex: { data: { id: "saucerswap-v2", type: "dex" } },
      },
    };

    const stage = await crawlGeckoTerminalPoolsStage({
      coinTargets: [deployment],
      cgPriceObservationTargets: new Set(),
      context: stageContext,
      dependencies: {
        crawlTokenPools,
        fetchGtTokenPools: vi.fn<typeof fetchGtTokenPools>(async () => [providerPool]),
        sleepWithSignal: vi.fn<typeof sleepWithSignal>(async () => {}),
      },
    });

    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      source: "gecko_terminal",
      chain: "hedera",
      baseToken: "0x00000000000000000000000000000000005c9f6b",
      tvlUsd: 18259,
    });
    expect(
      classifyDexDeploymentOutcomes({
        stablecoinId: "hchf-hedera-swiss-franc",
        deployments: [deployment],
        pools,
        providerChecks: stage.providerChecks,
        nowSec: 1_800_000_000,
      }),
    ).toEqual([
      expect.objectContaining({
        address: "0.0.6070123",
        outcome: "observed_pools",
        providers: ["geckoterminal"],
        observedPoolCount: 1,
      }),
    ]);
  });

  it("correlates an Injective provider-native EVM token back to its registry deployment", async () => {
    const deployment = target("usdc-circle", "injective");
    const pools: StagedPool[] = [];
    const stageContext = createCrawlStageContext({
      stablecoinId: "usdc-circle",
      knownPoolIds: new Set(),
      nowSec: 1_800_000_000,
      pools,
      priceObs: [],
    });
    const providerPool: GtPool = {
      id: "injective_inj19tynv2ufr2e6p5nn909z8rzp2apl3nj5zqseqj",
      type: "pool",
      attributes: {
        address: "inj19tynv2ufr2e6p5nn909z8rzp2apl3nj5zqseqj",
        name: "USDC / SAI",
        pool_created_at: "2026-07-30T11:23:13.000Z",
        base_token_price_usd: "0.9975663978",
        quote_token_price_usd: "0.0863532688871917",
        reserve_in_usd: "43475.8483",
        volume_usd: { h24: "435.9726933615" },
      },
      relationships: {
        base_token: {
          data: {
            id: "injective_erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
            type: "token",
          },
        },
        quote_token: {
          data: {
            id: "injective_factory/inj10aa0h5s0xwzv95a8pjhwluxcm5feeqygdk3lkm/SAI",
            type: "token",
          },
        },
        dex: { data: { id: "choice", type: "dex" } },
      },
    };
    const fetchPools = vi.fn<typeof fetchGtTokenPools>(async () => [providerPool]);

    const stage = await crawlGeckoTerminalPoolsStage({
      coinTargets: [deployment],
      cgPriceObservationTargets: new Set(),
      context: stageContext,
      dependencies: {
        crawlTokenPools,
        fetchGtTokenPools: fetchPools,
        sleepWithSignal: vi.fn<typeof sleepWithSignal>(async () => {}),
      },
    });

    expect(fetchPools).toHaveBeenCalledWith(
      "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
      "injective",
      expect.any(AbortSignal),
      0,
      8_000,
    );
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      source: "gecko_terminal",
      chain: "injective",
      baseToken: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
      quoteToken: "factory/inj10aa0h5s0xwzv95a8pjhwluxcm5feeqygdk3lkm/SAI",
      tvlUsd: 43475.8483,
    });
    expect(
      classifyDexDeploymentOutcomes({
        stablecoinId: "usdc-circle",
        deployments: [deployment],
        pools,
        providerChecks: stage.providerChecks,
        nowSec: 1_800_000_000,
      }),
    ).toEqual([
      expect.objectContaining({
        address: "0xa00c59ff5a080d2b954d0c75e46e22a0c371235a",
        outcome: "observed_pools",
        providers: ["geckoterminal"],
        observedPoolCount: 1,
      }),
    ]);
  });
});
