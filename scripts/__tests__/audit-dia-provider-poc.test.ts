import { describe, expect, it, vi } from "vitest";
import { jsonResponse } from "@shared/test-utils/mock-fetch";
import {
  parseDiaQuotation,
  runDiaProviderPocAudit,
  selectDiaProbeTargets,
  type DiaAuditReport,
} from "../maintenance/audit-dia-provider-poc";
import type { PriceSourceDepthAudit } from "../maintenance/audit-price-source-depth";

function makeAudit(): Pick<PriceSourceDepthAudit, "rows"> {
  return {
    rows: [
      {
        coinId: "alpha-usd",
        symbol: "ALPHA",
        name: "Alpha USD",
        status: "active",
        marketCapUsd: 500,
        price: 1,
        priceSource: "coingecko",
        priceConfidence: "single-source",
        primaryTrust: "single-source",
        pegSummaryPresent: true,
        stablecoinPresent: true,
        consensusSources: ["coingecko", "pyth"],
        agreeSources: ["coingecko", "pyth"],
        authoritativeAgreeSources: [],
        candidateSourceCount: 2,
        agreeSourceCount: 2,
        authoritativeAgreeSourceCount: 0,
        sourceClassifications: [],
        metadata: {
          geckoId: true,
          llamaId: false,
          pythFeedId: true,
          cmcSlug: false,
          contracts: 1,
          tradedContracts: 0,
        },
        candidateTriage: {
          currentSources: ["coingecko", "pyth"],
          missingFields: [],
          fieldAlreadyPresent: ["contracts"],
          potentialNewSource: null,
          pipelineLane: "primary",
          expectedMetricImpact: "needs-runtime-provider-change",
          expectedTrustImpact: "unknown",
          verificationSourceUrl: "",
          blocker: "",
        },
        fallbackOnlyFill: false,
        missingOrUnusablePrice: false,
      },
      {
        coinId: "beta-usd",
        symbol: "BETA",
        name: "Beta USD",
        status: "active",
        marketCapUsd: 250,
        price: 1,
        priceSource: "coingecko",
        priceConfidence: "high",
        primaryTrust: "high",
        pegSummaryPresent: true,
        stablecoinPresent: true,
        consensusSources: ["coingecko", "pyth", "kraken"],
        agreeSources: ["coingecko", "pyth", "kraken"],
        authoritativeAgreeSources: [],
        candidateSourceCount: 3,
        agreeSourceCount: 3,
        authoritativeAgreeSourceCount: 0,
        sourceClassifications: [],
        metadata: {
          geckoId: true,
          llamaId: false,
          pythFeedId: true,
          cmcSlug: false,
          contracts: 1,
          tradedContracts: 0,
        },
        candidateTriage: {
          currentSources: ["coingecko", "pyth", "kraken"],
          missingFields: [],
          fieldAlreadyPresent: ["contracts"],
          potentialNewSource: null,
          pipelineLane: "primary",
          expectedMetricImpact: "no-count-impact",
          expectedTrustImpact: "unknown",
          verificationSourceUrl: "",
          blocker: "",
        },
        fallbackOnlyFill: false,
        missingOrUnusablePrice: false,
      },
    ],
  };
}

describe("audit-dia-provider-poc", () => {
  it("selects below-target rows by market cap and exact supported contracts only", () => {
    const coinMetaById = new Map([
      ["alpha-usd", {
        contracts: [
          { chain: "ethereum", address: "0xAlpha", decimals: 18 },
          { chain: "near", address: "alpha.near", decimals: 24 },
        ],
      }],
      ["beta-usd", {
        contracts: [{ chain: "ethereum", address: "0xBeta", decimals: 18 }],
      }],
    ]);

    expect(selectDiaProbeTargets(makeAudit(), { coinMetaById })).toEqual({
      skippedNoSupportedContractCount: 0,
      targets: [{
        stablecoinId: "alpha-usd",
        symbol: "ALPHA",
        name: "Alpha USD",
        marketCapUsd: 500,
        pharosPrice: 1,
        currentSourceCount: 2,
        currentSources: ["coingecko", "pyth"],
        chain: "ethereum",
        diaBlockchain: "Ethereum",
        address: "0xAlpha",
      }],
    });
  });

  it("parses DIA quotation payloads without symbol fallback", () => {
    expect(parseDiaQuotation({
      Symbol: "USDC",
      Name: "USD Coin",
      Address: "0xA0b",
      Blockchain: "Ethereum",
      Price: 0.9999,
      PriceYesterday: 1,
      VolumeYesterdayUSD: 123,
      Time: "2026-05-12T00:00:00Z",
      Source: "diadata.org",
      Signature: "0xsig",
    })).toEqual({
      symbol: "USDC",
      name: "USD Coin",
      address: "0xA0b",
      blockchain: "Ethereum",
      price: 0.9999,
      priceYesterday: 1,
      volumeYesterdayUsd: 123,
      time: "2026-05-12T00:00:00Z",
      source: "diadata.org",
      signature: "0xsig",
    });
  });

  it("runs an audit-only probe with mocked DIA responses", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      Symbol: "ALPHA",
      Name: "Alpha USD",
      Address: "0xAlpha",
      Blockchain: "Ethereum",
      Price: 0.998,
      VolumeYesterdayUSD: 100_000,
      Time: "2026-05-12T00:00:00Z",
      Source: "diadata.org",
      Signature: "0xsig",
    }));

    const report = await runDiaProviderPocAudit({
      audit: makeAudit() as PriceSourceDepthAudit,
      nowMs: Date.parse("2026-05-12T00:30:00Z"),
      fetchImpl: fetchImpl as typeof fetch,
      coinMetaById: new Map([
        ["alpha-usd", {
          contracts: [{ chain: "ethereum", address: "0xAlpha", decimals: 18 }],
        }],
      ]),
    });

    expect(report).toMatchObject<Partial<DiaAuditReport>>({
      source: "dia-audit-only",
      targetCount: 1,
      checkedCount: 1,
      hitCount: 1,
      freshHitCount: 1,
      agreementWithin50BpsCount: 1,
      skippedNoSupportedContractCount: 0,
    });
    expect(report.results[0]).toMatchObject({
      stablecoinId: "alpha-usd",
      ok: true,
      diaPrice: 0.998,
      diaAgeSec: 1800,
      timestampQuality: "fresh",
      sourceMetadata: {
        source: "diadata.org",
        signaturePresent: true,
      },
    });
    expect(report.results[0]?.agreementBps).toBeCloseTo(20);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.diadata.org/v1/assetQuotation/Ethereum/0xAlpha",
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });
});
