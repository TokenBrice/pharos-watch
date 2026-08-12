import { describe, expect, it, vi } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { ContractDeployment } from "@shared/types/core";
import { sleepWithSignal } from "../../../lib/abort";
import { crawlTokenPools } from "../../dex-liquidity/crawl-helpers";
import { fetchGtTokenPools } from "../../dex-liquidity/geckoterminal-shared";
import { crawlGeckoTerminalPoolsStage } from "../crawl-geckoterminal-pools";
import { classifyDexDeploymentOutcomes } from "../deployment-outcomes";
import { createCrawlStageContext } from "../staged-pool";

const TARGET_IDS = new Set([
  "eursafo-spiko",
  "eurspkcc-spiko",
  "eutbl-spiko",
  "gbpsafo-spiko",
  "m-m0",
  "safo-spiko-usd",
  "spkcc-spiko",
  "uktbl-spiko",
  "usdh-hermetica",
  "ustbl-spiko",
]);

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
  const meta = ACTIVE_STABLECOINS.find((coin) => coin.id === stablecoinId)!;
  return [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])].find(
    (deployment) => deployment.chain === chain,
  )!;
}

describe("supplemental GeckoTerminal deployment discovery", () => {
  it("queries the ten production-shaped open-gap deployments and keeps their registry identities", async () => {
    const targets = ACTIVE_STABLECOINS.flatMap((coin) =>
      TARGET_IDS.has(coin.id)
        ? [...(coin.contracts ?? []), ...(coin.tradedContracts ?? [])].filter((deployment) =>
            ["starknet", "stacks", "mantra"].includes(deployment.chain),
          )
        : [],
    );
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

    expect(targets).toHaveLength(10);
    expect(fetchPools).toHaveBeenCalledTimes(10);
    expect(fetchPools.mock.calls.map(([address, network]) => [address, network])).toEqual(
      targets.map((deployment) => [
        deployment.chain === "starknet"
          ? `0x${deployment.address.slice(2).padStart(64, "0").toLowerCase()}`
          : deployment.chain === "mantra"
            ? deployment.address.toLowerCase()
            : deployment.address,
        deployment.chain === "starknet"
          ? "starknet-alpha"
          : deployment.chain === "stacks"
            ? "stacks"
            : "mantra-evm",
      ]),
    );
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
});
