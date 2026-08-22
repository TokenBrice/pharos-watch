import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

// Stub MINT_BURN_CONFIGS with two critical configs on different chains so the
// orchestrator must produce distinct chain contexts and emit events for both.
vi.mock("../../lib/mint-burn-contracts", () => ({
  MINT_BURN_BRIDGE_VALIDATION_ERROR_COUNT: 0,
  MINT_BURN_CONFIGS: [
    {
      chain: {
        chainId: "ethereum",
        chainName: "Ethereum",
        evmChainId: 1,
        explorerUrl: "https://etherscan.io",
        type: "evm",
      },
      stablecoinId: "usdt-tether",
      symbol: "USDT",
      contractAddress: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      decimals: 6,
      dustThreshold: 10_000,
      startBlock: 21_900_000,
      adapterKind: "mixed",
      startBlockSource: "reviewed-contract-specific",
      startBlockConfidence: "high",
      tier: "critical",
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
    },
    {
      chain: {
        chainId: "arbitrum",
        chainName: "Arbitrum",
        evmChainId: 42_161,
        explorerUrl: "https://arbiscan.io",
        type: "evm",
      },
      stablecoinId: "usdai-usd-ai",
      symbol: "USDai",
      contractAddress: "0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0",
      decimals: 18,
      dustThreshold: 10_000,
      startBlock: 249_000_000,
      adapterKind: "transfer-zero-address",
      startBlockSource: "reviewed-contract-specific",
      startBlockConfidence: "high",
      tier: "critical",
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
    },
  ],
}));

// Return distinct Alchemy URLs per chain so we can assert each chain was
// queried via its own endpoint (proves chain-context.ts builds per-chain URLs).
vi.mock("../../lib/alchemy-logs", () => ({
  buildAlchemyUrl: vi.fn((chainId: string) => `https://${chainId}.g.alchemy.example/v2/`),
  getAlchemyBlockNumber: vi.fn(async (url: string) =>
    url.includes("ethereum") ? 22_000_000 : 250_000_000,
  ),
  getAlchemyTransactionContextBatchMany: vi.fn(async (_url: string, txHashes: string[]) =>
    new Map(txHashes.map((txHash) => [txHash, {
      tx: { hash: txHash, to: "0xrouter", input: "0x96f4e9f9" },
      receipt: { transactionHash: txHash, to: "0xrouter", logs: [] },
    }])),
  ),
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, scannedToBlock: 0, calls: 1, maxDepth: 0 })),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

vi.mock("../../lib/evm-logs", () => ({
  createBudget: vi.fn((limit = 200) => ({ count: 0, limit })),
  budgetExhausted: vi.fn((budget: { count: number; limit: number }) => budget.count >= budget.limit),
  decodeUint256AtSlot: vi.fn(() => 50_000),
  decodeAddress: vi.fn((hex: string) => "0x" + hex.slice(-40)),
}));

// Capture per-batch bind payloads so we can assert events for both chains
// landed in the mint_burn_events insert path.
const capturedInsertBinds: unknown[][] = [];
vi.mock("../../lib/db", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/db")>();
  return {
    ...orig,
    batchExecute: vi.fn(async (_db: D1Database, stmts: D1PreparedStatement[]) => {
      for (const stmt of stmts) {
        const boundValues = (stmt as unknown as { boundValues?: unknown[]; sql?: string }).boundValues ?? [];
        const sql = (stmt as unknown as { sql?: string }).sql ?? "";
        if (sql.includes("INSERT OR IGNORE INTO mint_burn_events")) {
          capturedInsertBinds.push([...boundValues]);
        }
      }
      return stmts.length;
    }),
  };
});

vi.mock("../../lib/mint-burn-pipeline/persistence", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../lib/mint-burn-pipeline/persistence")>();
  return {
    ...orig,
    recalcAffectedHours: vi.fn(async () => undefined),
  };
});

vi.mock("../../lib/mint-burn-pipeline/price-heal", () => ({
  getNullPriceBacklog: vi.fn(async () => ({ recent: 0, historical: 0 })),
  healNullPrices: vi.fn(async () => ({ healed: 0, affectedHours: new Map() })),
}));

vi.mock("../../lib/mint-burn-pipeline/roundtrip-sweep", () => ({
  sweepRecentRoundtrips: vi.fn(async () => ({ reclassified: 0, affectedHours: new Map(), saturated: false })),
}));

import { syncMintBurn } from "../sync-mint-burn";
import {
  buildAlchemyUrl,
  fetchAlchemyLogs,
  getAlchemyBlockNumber,
  resolveBlockTimestamps,
} from "../../lib/alchemy-logs";

function makeDb(): D1Database {
  return mockD1([
    {
      match: "mint_burn_run_state",
      rows: [{ degraded_streak: 0, last_config_key: null }],
      first: { degraded_streak: 0, last_config_key: null },
    },
    { match: "mint_burn_sync_state", rows: [] },
    {
      match: "price_cache",
      rows: [
        { asset_id: "usdt-tether", price: 1.0 },
        { asset_id: "usdai-usd-ai", price: 1.0 },
      ],
    },
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "DELETE FROM cache WHERE key >= ? AND key < ?", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "mint_burn_hourly", rows: [] },
    { match: "mint_burn_events", rows: [] },
    { match: "SELECT config_key, deferred_until FROM mint_burn_config_deferral", rows: [] },
    { match: "INSERT OR REPLACE INTO mint_burn_config_deferral", rows: [] },
  ]);
}

function makeMintLog(opts: { contract: string; blockNumber: number; txHash: string }) {
  return {
    address: opts.contract,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12",
    ],
    data: "0x00000000000000000000000000000000000000000000000000000002540be400",
    blockNumber: "0x" + opts.blockNumber.toString(16),
    transactionHash: opts.txHash,
    transactionIndex: "0x0",
    blockHash: "0x0",
    logIndex: "0x0",
    removed: false,
  };
}

describe("syncMintBurn — multi-chain invariant", () => {
  beforeEach(() => {
    capturedInsertBinds.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-16T12:00:00Z"));
    vi.mocked(buildAlchemyUrl).mockClear();
    vi.mocked(getAlchemyBlockNumber).mockClear();
    vi.mocked(resolveBlockTimestamps).mockReset().mockResolvedValue(new Map());
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
      if (contract === "0xdac17f958d2ee523a2206206994597c13d831ec7") {
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
      (c) => c.contract === "0xdac17f958d2ee523a2206206994597c13d831ec7",
    );
    const arbLogCall = logFetchCallsByChain.find(
      (c) => c.contract === "0x2bd7d6b2e6bfcf61716bf5d7167e4c6b62a3f9c0",
    );
    expect(ethLogCall?.url).toContain("ethereum");
    expect(arbLogCall?.url).toContain("arbitrum");

    // The persistence layer must receive INSERT binds containing chain_id
    // values for BOTH chains (column index 3 on the insert tuple).
    const insertedChainIds = capturedInsertBinds.map((binds) => binds[3]);
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
