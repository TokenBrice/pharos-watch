import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { deriveSfraxStockPerimeter } from "@shared/lib/sfrax-supply";
import { SFRAX_STOCK_PERIMETER } from "@shared/lib/onchain-supply-probe";
import { getCirculatingRawOrNull } from "@shared/lib/supply";
import { StablecoinListResponseSchema } from "@shared/types/market";
import { bytesToBase64, base64ToBytes } from "@shared/lib/base64";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import * as evmRpc from "../../../../lib/evm-rpc";
import { getCache } from "../../../../lib/db-cache";
import { fetchSfraxStockSupply } from "../sfrax-supply";
import { fetchCuratedAggregateOnChainMcap, prefersOnChainSupplyMcap, toPublicChainCirculating } from "../onchain-supply";
import { buildSupplementalAsset } from "../shared";
import { normalizeStablecoinsPayload, mergeSupplementalLastKnownGood } from "../../shared";
import { validateAndWriteStablecoinsCache } from "../../cache-publication";
import capture from "./fixtures/sfrax-stock-2026-10-21.json";

const NOW = capture.readCompletedAt;
const PRICE = 1.25; // Explicit synthetic test scalar; the fixture is a token-stock observation, not a market quote.
const meta = TRACKED_META_BY_ID.get("sfrax-frax")!;
type EvmCapture = typeof capture.chains.ethereum;
const evmCaptures = Object.fromEntries(Object.entries(capture.chains).filter(([chain]) => chain !== "solana")) as Record<string, EvmCapture>;
const databases = createLatestSchemaFixtureTracker();
let missingChain: string | undefined;
let changedHeader: string | undefined;
let wrongIdentity: boolean;
let excessiveInventory: boolean;
let solanaFault: string | undefined;
let solanaValue: typeof capture.chains.solana.response;

function capturedWord(packet: EvmCapture, target: string, data: string): string | null {
  const request = packet.requests.find((request) => {
    const call = request.params[0] as { to: string; data: string };
    return call.to.toLowerCase() === target.toLowerCase() && call.data === data;
  });
  return request ? packet.responses.find((response) => response.id === request.id)?.result ?? null : null;
}

beforeEach(() => {
  missingChain = undefined; changedHeader = undefined; solanaFault = undefined;
  wrongIdentity = false; excessiveInventory = false;
  solanaValue = structuredClone(capture.chains.solana.response);
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  vi.spyOn(evmRpc, "fetchEvmBlockNumber").mockImplementation(async (chain) => evmCaptures[chain]?.block.number ?? null);
  const headersSeen = new Map<string, number>();
  vi.spyOn(evmRpc, "fetchEvmBlockHeader").mockImplementation(async (chain, number) => {
    const packet = evmCaptures[chain];
    if (!packet) return null;
    expect(number).toBe(packet.block.number);
    const seen = headersSeen.get(chain) ?? 0;
    headersSeen.set(chain, seen + 1);
    return { ...packet.block, hash: (changedHeader === chain && seen > 0 ? `0x${"f".repeat(64)}` : packet.block.hash) as `0x${string}` };
  });
  vi.spyOn(evmRpc, "fetchEvmRpcBatch").mockImplementation(async (chain, calls, options) => {
    const packet = chain ? evmCaptures[chain] : undefined;
    if (!packet || missingChain === chain) return null;
    expect(calls.length).toBeLessThanOrEqual(10);
    expect(options?.stateBlockHash).toBe(packet.block.hash);
    expect(options?.requireNonNullResults).toBe(true);
    return calls.map((call) => {
      expect(call.method).toBe("eth_call");
      expect(call.params[1]).toEqual({ blockHash: packet.block.hash, requireCanonical: true });
      const request = call.params[0] as { to: string; data: string };
      if (wrongIdentity && chain === "arbitrum" && request.data === "0xfc0c546a") return `0x${"0".repeat(64)}`;
      if (excessiveInventory && chain === "arbitrum" && request.data.startsWith("0x70a08231")) return `0x${(1_000_000n * 10n ** 18n).toString(16).padStart(64, "0")}`;
      return capturedWord(packet, request.to, request.data);
    });
  });
  vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    if (request.method === "getBlockTime") return Response.json({ result: solanaFault === "stale" ? NOW - 301 : solanaFault === "future" ? NOW + 1 : capture.chains.solana.block.timestamp });
    expect(request.method).toBe("getMultipleAccounts");
    expect(request.params).toEqual(capture.chains.solana.request.params);
    return Response.json(solanaValue);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); databases.closeAll(); });

async function observedAsset() {
  const result = await fetchSfraxStockSupply(meta, PRICE);
  expect(result).not.toBeNull();
  return buildSupplementalAsset({
    meta, priceResolution: null, mcap: result!.mcap, supplySource: result!.supplySource,
    supplyObservedAt: result!.observedAt, chainCirculating: toPublicChainCirculating(result!.chainCirculating), supplyPerimeter: result!.supplyPerimeter,
  });
}

describe("sFRAX current-token-stock perimeter", () => {
  it("dispatches the ordinary aggregate entry point to the complete stock reader, preferred over CG cap", async () => {
    expect(prefersOnChainSupplyMcap(meta)).toBe(true);
    const result = await fetchCuratedAggregateOnChainMcap(meta, PRICE);
    expect(result?.supplySource).toBe("onchain-circulating-supply");
    expect(deriveSfraxStockPerimeter(result?.supplyPerimeter)?.totalSupplyRaw.toString()).toBe(capture.expectedFloatRaw18);
  });
  it("replays every actual pinned stock and custody component, preserving one-raw Solana seed and including Compound", async () => {
    const asset = await observedAsset();
    const derived = deriveSfraxStockPerimeter(asset.supplyPerimeter)!;
    expect(derived.totalSupplyRaw.toString()).toBe(capture.expectedFloatRaw18);
    expect(Object.fromEntries(Object.entries(derived.chainSupplyRaw).map(([chain, raw]) => [chain, raw.toString()])))
      .toEqual(capture.expectedChainRaw18);
    expect(derived.observation.grossSupplyRaw.solana).toBe("117001");
    expect(derived.observation.nativeCustodyRaw.retiredZkevmFerry).toBe("20000000000000000000");
    expect(derived.observation.compoundHolderBalanceRaw).toBe("32550977989188964083475517");
    expect(derived.chainSupplyRaw.ethereum).toBeGreaterThan(BigInt(derived.observation.compoundHolderBalanceRaw));
    expect(derived.mcap / PRICE).toBeCloseTo(32_780_401.111922745, 7);
    expect(derived.observedAt).toBe(Math.min(...Object.values(capture.chains).map((packet) => packet.block.timestamp)));
    expect(asset.supplyPerimeter).not.toHaveProperty("pendingRaw");
    const normalized = normalizeStablecoinsPayload({ peggedAssets: [asset] }, capture.readStartedAt);
    const published = StablecoinListResponseSchema.parse(normalized).peggedAssets[0]!;
    expect(published.supplyUnavailableReason).toBeUndefined();
    expect(published.supplySource).toBe("onchain-circulating-supply");
    expect(getCirculatingRawOrNull(published)).toBe(derived.mcap);
    expect(published.chainCirculating.Avalanche.current).toBe(0); // Measured zero, not a failed leg.
    expect(evmRpc.fetchEvmBlockHeader).toHaveBeenCalledTimes(18);
  });

  it.each(["ethereum", "arbitrum", "avalanche", "base", "blast", "bsc", "fraxtal", "metis", "optimism"])(
    "withholds the entire generation when %s cannot be read", async (chain) => {
      missingChain = chain;
      await expect(fetchSfraxStockSupply(meta, PRICE)).resolves.toBeNull();
    },
  );
  it.each(["ethereum", "fraxtal"])("withholds a changed canonical %s header", async (chain) => {
    changedHeader = chain;
    await expect(fetchSfraxStockSupply(meta, PRICE)).resolves.toBeNull();
  });
  it("refuses unbound ferry identities and prefunded stock above issued supply", async () => {
    wrongIdentity = true;
    await expect(fetchSfraxStockSupply(meta, PRICE)).resolves.toBeNull();
    wrongIdentity = false; excessiveInventory = true;
    await expect(fetchSfraxStockSupply(meta, PRICE)).resolves.toBeNull();
  });
  it.each(["stale", "future", "mint", "adapter-kind", "owner"])("withholds an unusable Solana %s observation", async (fault) => {
    solanaFault = fault;
    if (fault === "owner") solanaValue.result.value[1].owner = "11111111111111111111111111111111";
    if (fault === "mint" || fault === "adapter-kind") {
      const bytes = base64ToBytes(solanaValue.result.value[1].data[0]);
      if (fault === "mint") bytes[16] ^= 1;
      else bytes[145] = 1;
      solanaValue.result.value[1].data[0] = bytesToBase64(bytes);
    }
    await expect(fetchSfraxStockSupply(meta, PRICE)).resolves.toBeNull();
  });
  it("rejects missing, extra or substituted catalog legs rather than reading a subtotal", async () => {
    for (const contract of meta.contracts!) {
      await expect(fetchSfraxStockSupply({ ...meta, contracts: meta.contracts!.filter((entry) => entry !== contract) }, PRICE)).resolves.toBeNull();
    }
    await expect(fetchSfraxStockSupply({ ...meta, contracts: [...meta.contracts!, meta.contracts![0]!] }, PRICE)).resolves.toBeNull();
    expect(evmRpc.fetchEvmRpcBatch).not.toHaveBeenCalled();
  });
  it("refuses unequal migrated ledger/custody and negative native float without clamping", async () => {
    const asset = await observedAsset();
    const observation = structuredClone(asset.supplyPerimeter!);
    observation.migratedDepositsRaw = "1";
    expect(deriveSfraxStockPerimeter(observation)).toBeNull();
    observation.migratedDepositsRaw = observation.nativeCustodyRaw.migratedStandardBridge;
    observation.nativeCustodyRaw.oftAdapter = observation.grossSupplyRaw.ethereum;
    expect(deriveSfraxStockPerimeter(observation)).toBeNull();
  });

  it.each(["main", "fallback"] as const)("admits only this run's complete packet at %s publication", async (validationContext) => {
    const asset = await observedAsset();
    const assets = [asset];
    const db = databases.open().db;
    const outcome = await validateAndWriteStablecoinsCache({ assets, db, syncStartSec: capture.readStartedAt, validationContext }, () => ({ metadata: "blocked" }));
    expect(outcome).toMatchObject({ written: true });
    const published = StablecoinListResponseSchema.parse(JSON.parse((await getCache(db, "stablecoins"))!.value)).peggedAssets[0]!;
    expect(published.supplyUnavailableReason).toBeUndefined();
    expect(published.supplyPerimeter?.method).toBe("sfrax-current-token-stock-v1");
    expect(getCirculatingRawOrNull(published)).toBe(asset.circulating!.peggedUSD);
    const nextRun = NOW + 1;
    vi.spyOn(Date, "now").mockReturnValue(nextRun * 1000);
    const carried = mergeSupplementalLastKnownGood([asset], new Map(), new Set(), nextRun).assets[0]!;
    expect(carried.supplyUnavailableReason).toBe("economic-float-unreconciled");
    expect(getCirculatingRawOrNull(carried)).toBeNull();
  });
  it("rejects tampered public quantities and a CG row reusing the valid packet", async () => {
    const asset = await observedAsset();
    for (const invalid of [
      { ...asset, supplySource: "coingecko-fallback" },
      { ...asset, circulating: { peggedUSD: asset.circulating!.peggedUSD + 1 } },
      { ...asset, supplyRestored: true },
    ]) {
      const published = normalizeStablecoinsPayload({ peggedAssets: [invalid] }, capture.readStartedAt).peggedAssets[0]!;
      expect(published.supplyUnavailableReason).toBe("economic-float-unreconciled");
      expect(getCirculatingRawOrNull(published)).toBeNull();
    }
  });
  it("keeps every reviewed native custody identity distinct", () => {
    const p = SFRAX_STOCK_PERIMETER;
    const custody = [p.migratedStandardBridge, p.oftAdapter, ...p.ferries.map((entry) => entry.native), ...p.historicalNativeFerries.map((entry) => entry.native)];
    expect(new Set(custody).size).toBe(custody.length);
  });
});
