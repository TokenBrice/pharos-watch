import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { buildChainRpcs } from "../chain-registry";
import { observeSafetyScoreV9TransferMaterialityGeneration, TRANSFER_MATERIALITY_CAPTURE_BUDGET } from "../safety-score-v9/transfer-materiality-observer";
import { SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS } from "../safety-score-v9/transfer-materiality";
import { fetchEvmMulticall3Aggregate3AtBlock } from "../evm-rpc";
import { sleepWithSignal } from "../abort";
import type * as TransferMaterialityModule from "../safety-score-v9/transfer-materiality";

// Exercise capacity without enrolling fabricated assets in any production registry.
vi.mock("../safety-score-v9/transfer-materiality", async importOriginal => {
  const original = await importOriginal<typeof TransferMaterialityModule>();
  return { ...original, SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS:
    Array.from({ length: 97 }, (_, index) => `capacity-fixture-${index.toString().padStart(2, "0")}`) };
});

const CLOCK = 1790850000;
const BASE = `report-cards-input:v1:${"a".repeat(64)}`;
function input(ids: readonly string[]) {
  return { activeAssetIds: ids, baseInputGenerationId: BASE, registryFingerprint: "b".repeat(64),
    scoringClockSec: CLOCK, chainRpcs: buildChainRpcs("test-alchemy") };
}
function aggregateReturn(callCount: number): string {
  const word = (n: number) => n.toString(16).padStart(64, "0");
  return `0x${word(32)}${word(callCount)}${Array.from({ length: callCount }, (_, i) =>
    word(callCount * 32 + i * 128)).join("")}${Array.from({ length: callCount }, (_, i) =>
    `${word(1)}${word(64)}${word(32)}${word(i % 2 === 0 ? 100 : 18)}`).join("")}`;
}

describe("expanded transfer census capacity", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it.each([30, 43])("observes 53 existing plus %s simple assets in bounded shared-chain batches", async added => {
    vi.useFakeTimers();
    const cohort = SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS.slice(0, 53 + added);
    const meta = ACTIVE_META_BY_ID.get("aa-falconx-mev-capital")!;
    const chains = ["ethereum", "bsc", "base", "arbitrum"];
    // Every test liability is a reviewed-shape, one-chain direct liability. This
    // models admission/transport cost, not real-chain throughput or curation.
    vi.spyOn(ACTIVE_META_BY_ID, "get").mockImplementation(id => ({
      ...meta, id, contracts: [{ chain: chains[cohort.indexOf(id) % chains.length]!, decimals: 18,
        address: `0x${(cohort.indexOf(id) + 1).toString(16).padStart(40, "0")}` }],
    }));
    let active = 0;
    let peak = 0;
    let requests = 0;
    const chunkShapes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests++;
      peak = Math.max(peak, ++active);
      try {
        await sleepWithSignal(100, init.signal ?? undefined);
        // calldata is aggregate3((address,bool,bytes)[]). Read the array length.
        const data = body.params[0].data as string;
        const count = Number(BigInt(`0x${data.slice(74, 138)}`));
        chunkShapes.push(count);
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: aggregateReturn(count) }));
      } finally { active--; }
    }));
    const started = Date.now();
    const operation = observeSafetyScoreV9TransferMaterialityGeneration(input(cohort), {
      resolveClosestBlockAtOrBeforeTimestamp: async () => 100,
      fetchEvmBlockHeader: async () => ({ number: 100, timestamp: CLOCK - 10, hash: `0x${"1".repeat(64)}` as `0x${string}` }),
      fetchEvmMulticall3Aggregate3AtBlock,
    });
    let completionWallMs = 0;
    const settled = operation.then(generation => {
      completionWallMs = Date.now() - started;
      return generation;
    });
    await vi.advanceTimersByTimeAsync(1000);
    const generation = await settled;
    expect(cohort.length).toBe(53 + added);
    expect(Object.keys(generation.observationsByAssetId)).toHaveLength(53 + added);
    expect(Object.values(generation.observationsByAssetId).every(rows => rows.length === 1 && rows[0].status === "accepted")).toBe(true);
    expect(requests).toBe(4);
    expect(chunkShapes.sort((a, b) => a - b)).toEqual(added === 30 ? [40, 42, 42, 42] : [48, 48, 48, 48]);
    expect(peak).toBe(3);
    expect(active).toBe(0);
    expect(completionWallMs).toBe(200);
  });

  it("bounds a crowded chain's direct-call fallback and preserves deferred assets as unknown", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const cohort = SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS.slice(0, 83);
    const meta = ACTIVE_META_BY_ID.get("aa-falconx-mev-capital")!;
    vi.spyOn(ACTIVE_META_BY_ID, "get").mockImplementation(id => ({
      ...meta, id, contracts: [{ chain: "ethereum", decimals: 18,
        address: `0x${(cohort.indexOf(id) + 1).toString(16).padStart(40, "0")}` }],
    }));
    const chainRpcs = new Map([["ethereum", {
      chainId: "ethereum", chainName: "Ethereum", type: "evm" as const, explorerUrl: "https://explorer.example",
      endpoints: [{ url: "https://rpc.example", operator: "public" as const, keyed: false,
        position: "registry" as const, stateHistory: "archive" as const, logsHistory: "none" as const }],
    }]]);
    let requests = 0;
    let active = 0;
    let peak = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      requests++;
      peak = Math.max(peak, ++active);
      try {
        await sleepWithSignal(100, init.signal ?? undefined);
        if (body.method === "eth_getCode") return new Response(JSON.stringify({ result: "0x" }));
        if (body.method === "eth_getBlockByNumber") return new Response(JSON.stringify({ result: {
          number: "0x64", timestamp: `0x${(CLOCK - 10).toString(16)}`, hash: `0x${"1".repeat(64)}`,
        } }));
        if (body.params[0].data.startsWith("0x82ad56cb")) {
          return new Response(JSON.stringify({ error: { code: -32000, message: "fixture aggregate unavailable" } }));
        }
        const value = body.params[0].data === "0x313ce567" ? 18 : 100;
        return new Response(JSON.stringify({ result: `0x${value.toString(16).padStart(64, "0")}` }));
      } finally { active--; }
    }));
    const started = Date.now();
    let completionWallMs = 0;
    const operation = observeSafetyScoreV9TransferMaterialityGeneration({ ...input(cohort), chainRpcs }, {
      resolveClosestBlockAtOrBeforeTimestamp: async () => 100,
      fetchEvmBlockHeader: async () => ({ number: 100, timestamp: CLOCK - 10, hash: `0x${"1".repeat(64)}` as `0x${string}` }),
      fetchEvmMulticall3Aggregate3AtBlock,
    }).then(generation => {
      completionWallMs = Date.now() - started;
      return generation;
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const generation = await operation;
    expect(requests).toBe(131); // Failed aggregate + absence + 128 direct calls + hash recheck.
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(completionWallMs).toBe(13_100);
    const rows = Object.values(generation.observationsByAssetId).flat();
    expect(rows.filter(row => row.status === "accepted")).toHaveLength(64);
    expect(rows.filter(row => row.status === "rejected" && row.rawTokenUnits === null)).toHaveLength(19);
  });

  it("refuses the 97th active candidate before any network work", async () => {
    const resolve = vi.fn(async () => 100);
    await expect(observeSafetyScoreV9TransferMaterialityGeneration(input(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS), {
      resolveClosestBlockAtOrBeforeTimestamp: resolve,
    })).rejects.toThrow("bounded cohort");
    expect(SAFETY_SCORE_V9_TRANSFER_MATERIALITY_ASSET_IDS).toHaveLength(TRANSFER_MATERIALITY_CAPTURE_BUDGET.maxAssets + 1);
    expect(resolve).not.toHaveBeenCalled();
  });
});
