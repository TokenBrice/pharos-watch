import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../fetch-retry";
import {
  chunk,
  createAddressProviderRunner,
  fetchProviderJson,
  groupTargetsByProviderChain,
  hasValue,
  incrementReason,
  normalizeAddressForKey,
  parseNonNegativeNumber,
  parsePositiveNumber,
} from "../address-price-providers/shared";
import type { AddressPriceTarget } from "../address-price-providers/types";

vi.mock("../fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

function target(id: string, address: string, providerChainId = "base"): AddressPriceTarget {
  return {
    stablecoinId: id,
    symbol: id.toUpperCase(),
    chain: providerChainId === "solana" ? "solana" : "base",
    providerChainId,
    address,
    origin: "contracts",
    previousSourceDepth: 1,
    previousMissingGenerations: 0,
    alertEligibleMissingPrice: false,
    recentlyMissingPrice: false,
    missingPrice: false,
    expiresBeforeNextGeneration: false,
    circulatingUsd: 1_000_000,
  };
}

describe("address-price provider shared contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes live-provider scalar inputs and batches", () => {
    expect(hasValue(" cg ")).toBe(true);
    expect(hasValue(" ")).toBe(false);
    expect(normalizeAddressForKey("  0xABCDEF  ")).toBe("0xabcdef");
    expect(normalizeAddressForKey("  SoLaNaAddress  ")).toBe("SoLaNaAddress");
    expect(parsePositiveNumber("1.25")).toBe(1.25);
    expect(parseNonNegativeNumber("0")).toBe(0);
    expect(parseNonNegativeNumber("-1")).toBeNull();
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);

    const reasons = {};
    incrementReason(reasons, "missing-quote");
    incrementReason(reasons, "missing-quote", 2);
    expect(reasons).toEqual({ "missing-quote": 3 });
  });

  it("groups live targets by CoinGecko network", () => {
    const base = target("base", "0x01");
    const solana = target("solana", "So111", "solana");
    expect([...groupTargetsByProviderChain([base, solana, target("base-2", "0x02")])]).toEqual([
      ["base", [base, expect.objectContaining({ stablecoinId: "base-2" })]],
      ["solana", [solana]],
    ]);
  });

  it("returns diagnostics for no response and rate limiting", async () => {
    vi.mocked(fetchWithRetry)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "120" },
      }));
    const fixtureTarget = target("fixture", "0x01");

    const missing = await fetchProviderJson({
      provider: "coingecko-onchain-address",
      url: "https://example.test/missing",
      endpoint: "fixture",
      candidateCount: 1,
      targets: [fixtureTarget],
      candidateAt: 1_800_000_000,
    });
    expect(missing.diagnostic).toMatchObject({
      errorClass: "no-response",
      rejectionReasonCounts: { "upstream-error": 1 },
    });

    const limited = await fetchProviderJson({
      provider: "coingecko-onchain-address",
      url: "https://example.test/limited",
      candidateCount: 1,
    });
    expect(limited.diagnostic).toMatchObject({
      status: 429,
      success: false,
      retryAfterSec: 120,
      snippet: "slow down",
    });
  });

  it("parses successful JSON and classifies malformed JSON", async () => {
    vi.mocked(fetchWithRetry)
      .mockResolvedValueOnce(Response.json({ data: [] }))
      .mockResolvedValueOnce(new Response("{broken", { status: 200 }));

    await expect(fetchProviderJson({
      provider: "coingecko-onchain-address",
      url: "https://example.test/ok",
      candidateCount: 0,
      init: { headers: { "X-Test": "yes" } },
    })).resolves.toMatchObject({ json: { data: [] } });

    const malformed = await fetchProviderJson({
      provider: "coingecko-onchain-address",
      url: "https://example.test/malformed",
      candidateCount: 0,
    });
    expect(malformed.json).toBeNull();
    expect(malformed.diagnostic.errorClass).toBe("SyntaxError");
  });

  it("tracks resolved, failed, and cap-skipped live targets", () => {
    const resolved = target("resolved", "0x01");
    const skipped = target("skipped", "0x02");
    const runner = createAddressProviderRunner({
      provider: "coingecko-onchain-address",
      label: "CoinGecko onchain",
      targets: [resolved, skipped],
      deadlineMs: Date.now() + 60_000,
      maxRequests: 1,
    });

    expect(runner.canStartRequest()).toBe(true);
    runner.beginRequest();
    expect(runner.canStartRequest()).toBe(false);
    runner.recordSuccess();
    runner.quotes.push({
      stablecoinId: resolved.stablecoinId,
      source: "coingecko-onchain-address",
      chain: resolved.chain,
      address: resolved.address,
      priceUsd: 1,
      observedAt: 1_800_000_000,
      observedAtMode: "local_fetch",
    });
    runner.markProcessed([resolved]);
    runner.recordDiagnostic({
      source: "coingecko-onchain-address",
      stage: "primary",
      endpoint: "fixture",
      status: 200,
      ok: true,
      success: true,
      candidateCount: 1,
      assetAttempts: [{
        assetId: resolved.stablecoinId,
        adapter: "coingecko-onchain-address",
        source: "coingecko-onchain-address",
        chain: resolved.chain,
        target: resolved.address,
        state: "attempted",
        result: "unresolved",
        candidateAt: 1_800_000_000,
        replaySafe: true,
      }],
    });

    const result = runner.finish();
    expect(result).toMatchObject({ attemptedRequests: 1, successfulRequests: 1 });
    expect(result.diagnostics[0]?.assetAttempts?.[0]).toMatchObject({
      result: "resolved",
      observedAt: 1_800_000_000,
    });
    expect(result.diagnostics[1]?.assetAttempts?.[0]).toMatchObject({
      state: "skipped",
      skipReason: "request-cap",
      rejectionClass: "cap",
    });
  });

  it("marks unresolved attempts failed or rejected from provider diagnostics", () => {
    const fixtureTarget = target("fixture", "0x01");
    const runner = createAddressProviderRunner({
      provider: "coingecko-onchain-address",
      label: "CoinGecko onchain",
      targets: [fixtureTarget],
      deadlineMs: Date.now() + 60_000,
      maxRequests: 1,
    });
    const attempt = {
      assetId: fixtureTarget.stablecoinId,
      adapter: "coingecko-onchain-address" as const,
      source: "coingecko-onchain-address",
      chain: fixtureTarget.chain,
      target: fixtureTarget.address,
      state: "attempted" as const,
      result: "unresolved" as const,
      candidateAt: 1_800_000_000,
      replaySafe: true,
    };

    runner.recordDiagnostic({
      source: "coingecko-onchain-address",
      stage: "primary",
      endpoint: "failed",
      status: 500,
      ok: false,
      success: false,
      errorClass: "upstream-error",
      candidateCount: 1,
      assetAttempts: [attempt],
    });
    runner.recordDiagnostic({
      source: "coingecko-onchain-address",
      stage: "primary",
      endpoint: "rejected",
      status: 200,
      ok: true,
      success: true,
      candidateCount: 1,
      rejectionReasonCounts: { "price-rejected": 1 },
      assetAttempts: [attempt],
    });
    runner.markProcessed([fixtureTarget]);

    const result = runner.finish();
    expect(result.diagnostics[0]?.assetAttempts?.[0]).toMatchObject({
      result: "failed",
      rejectionClass: "upstream-error",
    });
    expect(result.diagnostics[1]?.assetAttempts?.[0]).toMatchObject({
      result: "rejected",
      rejectionClass: "price-rejected",
    });
  });
});
