import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  makeMintBurnDb,
  makeMintBurnMintLog as makeMintLog,
  mintBurnEventInsertBinds,
  resetMintBurnMocks,
  USDT_CONTRACT,
} from "./mint-burn.test-support";

// Stub MINT_BURN_CONFIGS with two critical configs on different chains so the
// orchestrator must produce distinct chain contexts and emit events for both.
vi.mock("../../lib/mint-burn-contracts", async () => {
  const { makeMintBurnConfig } = await import("../../test-helpers/__shared/mint-burn");
  return {
    MINT_BURN_CONFIGS: [
      makeMintBurnConfig({
        asset: {
          contractAddress: USDT_CONTRACT,
          tier: "critical",
        },
        adapter: "mixed",
        events: [
          {
            signature: "Transfer(address,address,uint256)",
            topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            direction: "mint",
            amountEncoding: "transfer-value",
            filterTopic: {
              index: 1,
              value: "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        ],
      }),
      makeMintBurnConfig({
        chain: {
          chainId: "arbitrum",
          chainName: "Arbitrum",
          evmChainId: 42_161,
          explorerUrl: "https://arbiscan.io",
        },
        asset: {
          stablecoinId: "usdai-usd-ai",
          symbol: "USDai",
          contractAddress: "0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0",
          decimals: 18,
          startBlock: 249_000_000,
          tier: "critical",
        },
        adapter: "transfer-zero-address",
        events: [
          {
            signature: "Transfer(address,address,uint256)",
            topicHash: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            direction: "mint",
            amountEncoding: "transfer-value",
            filterTopic: {
              index: 1,
              value: "0x0000000000000000000000000000000000000000000000000000000000000000",
            },
          },
        ],
      }),
    ],
  };
});

import { syncMintBurn } from "../sync-mint-burn";
import {
  buildAlchemyUrl,
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  resolveBlockTimestamps,
} from "../../lib/alchemy-logs";

function makeDb(): D1Database {
  return makeMintBurnDb({
    priceRows: [
      { asset_id: "usdt-tether", price: 1.0 },
      { asset_id: "usdai-usd-ai", price: 1.0 },
    ],
  });
}

describe("syncMintBurn — multi-chain invariant", () => {
  beforeEach(() => {
    resetMintBurnMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("builds per-chain Alchemy endpoints and ingests events for each chain", async () => {
    const db = makeDb();

    // One mint on Ethereum (USDT), one on Arbitrum (USDai). The remaining
    // fetch call resolves with an empty log set.
    vi.mocked(fetchAlchemyLogs).mockImplementation(async (_url, contract) => {
      if (contract === USDT_CONTRACT) {
        return {
          logs: [
            makeMintLog({
              contract,
              blockNumber: 22_000_000,
              txHash: "0xeth-mint",
            }),
          ],
          complete: true,
          scannedToBlock: 22_000_000,
          calls: 1,
          maxDepth: 0,
        };
      }
      if (contract === "0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0") {
        return {
          logs: [
            makeMintLog({
              contract,
              blockNumber: 249_500_000,
              txHash: "0xarb-mint",
            }),
          ],
          complete: true,
          scannedToBlock: 249_500_000,
          calls: 1,
          maxDepth: 0,
        };
      }
      return { logs: [], complete: true, scannedToBlock: 0, calls: 1, maxDepth: 0 };
    });

    vi.mocked(resolveBlockTimestamps).mockImplementation(async (url: string) => {
      if (url.includes("ethereum")) return new Map([[22_000_000, 1_744_000_000]]);
      return new Map([[249_500_000, 1_744_000_100]]);
    });

    const result = await syncMintBurn(db, "alchemy-key");
    expect(result.status).toBe("ok");

    // buildAlchemyUrl must be called once per distinct chain id.
    const buildUrlChainIds = vi
      .mocked(buildAlchemyUrl)
      .mock.calls.map((call) => call[0]);
    expect(new Set(buildUrlChainIds)).toEqual(new Set(["ethereum", "arbitrum"]));

    // Alchemy endpoints must be queried via distinct per-chain URLs.
    const blockNumberUrls = vi
      .mocked(getAlchemyBlockNumber)
      .mock.calls.map((call) => call[0] as string);
    expect(blockNumberUrls.some((url) => url.includes("ethereum"))).toBe(true);
    expect(blockNumberUrls.some((url) => url.includes("arbitrum"))).toBe(true);

    // Log fetches must route to the correct chain's Alchemy endpoint.
    const logFetchCallsByChain = vi
      .mocked(fetchAlchemyLogs)
      .mock.calls.map((call) => ({
        url: call[0] as string,
        contract: call[1] as string,
      }));
    const ethLogCall = logFetchCallsByChain.find(
      (c) => c.contract === USDT_CONTRACT,
    );
    const arbLogCall = logFetchCallsByChain.find(
      (c) => c.contract === "0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0",
    );
    expect(ethLogCall?.url).toContain("ethereum");
    expect(arbLogCall?.url).toContain("arbitrum");

    // The persistence layer must receive INSERT binds containing chain_id
    // values for BOTH chains (column index 3 on the insert tuple).
    const insertedChainIds = mintBurnEventInsertBinds.map((binds) => binds[3]);
    expect(insertedChainIds).toContain("ethereum");
    expect(insertedChainIds).toContain("arbitrum");

    // Metadata must carry chainHeads for both chains, proving the run-completion
    // path preserves multi-chain context rather than collapsing to Ethereum.
    const meta = JSON.parse(result.metadata);
    expect(meta.chainHeads).toMatchObject({
      ethereum: 22_000_000,
      arbitrum: 250_000_000,
    });
  });
});
