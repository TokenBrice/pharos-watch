import { describe, expect, it } from "vitest";
import {
  applyNonOkProviderDiagnostic,
  buildBlockedProviderDiagnostic,
  buildNoCandidatesDiagnostic,
  buildPricingProviderDiagnostic,
} from "../pricing-provider-lifecycle";

describe("pricing provider lifecycle helpers", () => {
  it("builds no-candidate diagnostics with the recovery shape", () => {
    expect(buildNoCandidatesDiagnostic({
      source: "jupiter",
      stage: "no-candidates",
      endpoint: "none",
    })).toEqual({
      source: "jupiter",
      stage: "no-candidates",
      endpoint: "none",
      status: null,
      ok: true,
      success: true,
      candidateCount: 0,
    });
  });

  it("builds blocked diagnostics with a normalized rejection count", () => {
    expect(buildBlockedProviderDiagnostic({
      source: "coinmarketcap",
      stage: "fallback",
      endpoint: "pro-api.coinmarketcap.com/v1/cryptocurrency/category",
      candidateCount: 3,
    }, "CoinMarketCap circuit open")).toMatchObject({
      source: "coinmarketcap",
      stage: "fallback",
      ok: false,
      success: false,
      candidateCount: 3,
      errorClass: "blocked",
      errorMessage: "CoinMarketCap circuit open",
      rejectionReasonCounts: { blocked: 1 },
    });
  });

  it("captures non-OK snippets and rejection counts", async () => {
    const diagnostic = buildPricingProviderDiagnostic({
      source: "dexscreener-search",
      stage: "fallback",
      endpoint: "api.dexscreener.com/latest/dex/search",
      candidateCount: 1,
    }, {
      status: 403,
      ok: false,
    });

    await expect(applyNonOkProviderDiagnostic(
      diagnostic,
      new Response("blocked by provider", { status: 403 }),
    )).resolves.toMatchObject({
      status: 403,
      ok: false,
      success: false,
      snippet: "blocked by provider",
      rejectionReasonCounts: { "non-ok": 1 },
    });
  });
});
