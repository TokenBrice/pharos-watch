import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../test-helpers/__shared/auth";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

stubCryptoForAuth();

vi.mock("../../lib/alchemy-logs", () => ({
  buildAlchemyUrl: vi.fn(() => "https://eth-mainnet.g.alchemy.com/v2/"),
  getAlchemyBlockNumber: vi.fn(async () => 22_000_000),
  getAlchemyTransactionContextBatchMany: vi.fn(async () => new Map()),
  fetchAlchemyLogs: vi.fn(async () => ({ logs: [], complete: true, scannedToBlock: 22_000_000, calls: 1, maxDepth: 0 })),
  resolveBlockTimestamps: vi.fn(async () => new Map()),
}));

import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { handleBackfillMintBurn } from "../backfill-mint-burn";
import {
  fetchAlchemyLogs,
  getAlchemyTransactionContextBatchMany,
  resolveBlockTimestamps,
} from "../../lib/alchemy-logs";

const mutableActiveIds = ACTIVE_IDS as Set<string>;

function makeBackfillDb() {
  return mockD1([
    { match: "mint_burn_sync_state", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "price_cache", rows: [] },
    { match: "mint_burn", rows: [] },
  ]);
}

describe("handleBackfillMintBurn", () => {
  const originalActiveIds = new Set(ACTIVE_IDS);

  beforeEach(() => {
    vi.clearAllMocks();
    mutableActiveIds.clear();
    for (const id of originalActiveIds) mutableActiveIds.add(id);
  });

  it("auto-selects a config when configKey is omitted", async () => {
    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }), alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      configKey: string;
      selectedSymbol: string;
      selectionMode: string;
      autoSelectedReason: string | null;
    };
    expect(body.configKey).toBe("ethereum-0xdac17f958d2ee523a2206206994597c13d831ec7");
    expect(body.selectedSymbol).toBe("USDT");
    expect(body.selectionMode).toBe("auto");
    expect(body.autoSelectedReason).toBe("critical-first-most-behind");
  });

  it("skips inactive configs during automatic selection", async () => {
    mutableActiveIds.delete("usdt-tether");

    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }), alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      configKey: string;
      selectedSymbol: string;
      selectionMode: string;
      autoSelectedReason: string | null;
    };
    expect(body.configKey).toBe("ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(body.selectedSymbol).toBe("USDC");
    expect(body.selectionMode).toBe("auto");
    expect(body.autoSelectedReason).toBe("critical-first-most-behind");
  });

  it("returns 404 for an unknown configKey", async () => {
    const response = await handleBackfillMintBurn({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ configKey: "ethereum-0xdeadbeef" }),
      }), alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 404)) as { error: string };
    expect(body.error).toContain("Unknown mint/burn configKey");
  });

  it("rejects malformed JSON bodies", async () => {
    const response = await handleBackfillMintBurn({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }), alchemyApiKey: "alchemy-key" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("rejects non-object JSON bodies", async () => {
    const response = await handleBackfillMintBurn({ db: makeNoopD1(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(["not-an-object"]),
      }), alchemyApiKey: "alchemy-key" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "Invalid JSON body" });
  });

  it("returns done when requested range is empty", async () => {
    const request = makeApiRequest("/api/backfill-mint-burn", {
      method: "POST",
      adminKey: "secret",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        fromBlock: 100,
        toBlock: 90,
      }),
    });

    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request, alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      done: boolean;
      chunksProcessed: number;
      effectiveBurns: number;
      bridgeBurns: number;
      reviewBurns: number;
      txContextShortfalls: number;
    };
    expect(body.done).toBe(true);
    expect(body.chunksProcessed).toBe(0);
    expect(body.effectiveBurns).toBe(0);
    expect(body.bridgeBurns).toBe(0);
    expect(body.reviewBurns).toBe(0);
    expect(body.txContextShortfalls).toBe(0);
  });

  it("returns nextFromBlock when maxChunks stops before toBlock", async () => {
    const request = makeApiRequest("/api/backfill-mint-burn", {
      method: "POST",
      adminKey: "secret",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        fromBlock: 100,
        toBlock: 280,
        chunkSize: 50,
        maxChunks: 2,
      }),
    });

    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request, alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      done: boolean;
      nextFromBlock: number | null;
      chunksProcessed: number;
    };

    expect(body.done).toBe(false);
    expect(body.chunksProcessed).toBe(2);
    expect(body.nextFromBlock).toBe(200);
  });

  it("clamps a body-supplied out-of-range maxChunks to the allowed bounds", async () => {
    // readAdminIntegerParam only digit-checks, so a body maxChunks bypasses the
    // parseQueryParams max bound; the handler must re-clamp it (audit Q-234).
    // maxChunks: 0 would otherwise skip the loop entirely (0 chunks); clamped to
    // the min of 1, exactly one chunk runs over the single-chunk range.
    const request = makeApiRequest("/api/backfill-mint-burn", {
      method: "POST",
      adminKey: "secret",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        configKey: "ethereum-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        fromBlock: 100,
        toBlock: 140,
        chunkSize: 50,
        maxChunks: 0,
      }),
    });

    const response = await handleBackfillMintBurn({ db: makeBackfillDb(), url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request, alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as { done: boolean; chunksProcessed: number };
    expect(body.chunksProcessed).toBe(1);
    expect(body.done).toBe(true);
  });

  it("updates flow_type on existing rows when classifier output differs", async () => {
    // Seed a USDC mint log for a CCTP bridge tx. The classifier should tag it
    // bridge_transfer under the new CCIP/CCTP mint-tagging rule (Task 1.1).
    // Assert the response reports flowTypeChanges and the pipeline ran the
    // flow_type UPDATE against the row and recalculated the affected hour.
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const ZERO_TOPIC = "0x0000000000000000000000000000000000000000000000000000000000000000";
    const CCTP_DEPOSIT_FOR_BURN_TOPIC =
      "0x2fa9ca894982930190727e75500a97d8dc500233a5065e0f3126c48fbe0343c0";
    const USDC_CONTRACT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
    const TX_HASH = "0xcctpbridgemint";
    const BLOCK_NUMBER = 21_950_000;
    const MINT_RECIPIENT = "0x000000000000000000000000abcdef1234567890abcdef1234567890abcdef12";

    vi.mocked(fetchAlchemyLogs).mockReset().mockImplementation(async (_url, _address, topics) => {
      const isMintTopic = topics.some(
        (t) => t.index === 1 && t.value === ZERO_TOPIC,
      );
      if (!isMintTopic) {
        return { logs: [], complete: true, scannedToBlock: BLOCK_NUMBER, calls: 1, maxDepth: 0 };
      }
      return {
        logs: [
          {
            address: USDC_CONTRACT,
            topics: [TRANSFER_TOPIC, ZERO_TOPIC, MINT_RECIPIENT],
            data: "0x00000000000000000000000000000000000000000000000000000002540be400", // 10_000_000_000
            blockNumber: "0x" + BLOCK_NUMBER.toString(16),
            transactionHash: TX_HASH,
            transactionIndex: "0x0",
            blockHash: "0x0",
            logIndex: "0x0",
            removed: false,
          },
        ],
        complete: true,
        scannedToBlock: BLOCK_NUMBER,
        calls: 1,
        maxDepth: 0,
      };
    });

    vi.mocked(resolveBlockTimestamps)
      .mockReset()
      .mockResolvedValue(new Map([[BLOCK_NUMBER, 1_730_000_000]]));

    // Stub the CCTP signal: receipt emits the bridge-signal topic, so the
    // classifier flips flow_type standard → bridge_transfer for the mint row.
    const txContext = {
      tx: {
        hash: TX_HASH,
        to: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
        input: "0x6fd3504e",
      },
      receipt: {
        transactionHash: TX_HASH,
        to: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
        logs: [
          {
            address: "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d",
            topics: [CCTP_DEPOSIT_FOR_BURN_TOPIC],
            data: "0x",
            blockNumber: "0x" + BLOCK_NUMBER.toString(16),
            transactionHash: TX_HASH,
            transactionIndex: "0x0",
            blockHash: "0x0",
            logIndex: "0x0",
            removed: false,
          },
        ],
      },
    };
    vi.mocked(getAlchemyTransactionContextBatchMany)
      .mockReset()
      .mockResolvedValue(new Map([[TX_HASH, txContext]]));

    const db = makeBackfillDb();

    const response = await handleBackfillMintBurn({ db, url: makeApiUrl("/api/backfill-mint-burn"), trustedAdmin: true, request: makeApiRequest("/api/backfill-mint-burn", {
        method: "POST",
        adminKey: "secret",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configKey: `ethereum-${USDC_CONTRACT}`,
          fromBlock: BLOCK_NUMBER,
          toBlock: BLOCK_NUMBER,
        }),
      }), alchemyApiKey: "alchemy-key" });

    const body = (await readJsonResponse(response, 200)) as {
      reclassified: { flowTypeChanges: number; burnTypeChanges: number };
    };

    expect(body.reclassified).toBeDefined();
    expect(body.reclassified.flowTypeChanges).toBeGreaterThanOrEqual(1);
    // Mint-only fixture: no burns should be counted on the burn column, even
    // though the unified UPDATE writes `burn_type = NULL` unconditionally.
    expect(body.reclassified.burnTypeChanges).toBe(0);
    // The classifier output ("bridge_transfer") must reach the UPDATE, and the
    // affected hour bucket must be queued for recalculation.
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("UPDATE mint_burn_events") && entry.binds.includes("bridge_transfer"))).toBe(true);
    expect(history.filter((entry) => entry.sql.includes("mint_burn_hourly") && (entry.sql.includes("INSERT OR REPLACE") || entry.sql.includes("DELETE FROM"))).length).toBeGreaterThanOrEqual(1);
  });
});
