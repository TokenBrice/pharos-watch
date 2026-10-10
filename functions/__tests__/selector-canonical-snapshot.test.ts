import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SITE_DATA_PROXY_SECRET_HEADER } from "@shared/lib/site-data-lane";
import type { SelectorInput } from "@shared/lib/selector/types";
import { makeReportCardsV9Response, makeV9Card } from "../../src/test/fixtures/safety-score-v9";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { recomputeVerifiedSelectorSnapshot } from "../lib/selector-canonical-snapshot";
import { makeAltYieldSource, makeYieldRanking } from "@shared/test-utils/yield-ranking-fixtures";
import { computeSelectorSnapshotSid, validateVerifiedSelectorSnapshot } from "@shared/lib/selector/snapshot";

const input = {
  profile: "treasury",
  pegCurrency: "USD",
  horizon: "6mplus",
  depegTolerance: "zero",
  composability: "none",
  exitSpeed: "any",
  venuePreferences: ["custody"],
  minApy: null,
  yieldNativeOnly: false,
  decentralization: "any",
  custodyOk: "any",
} satisfies SelectorInput;

function methodology(version: string) {
  return {
    version,
    versionLabel: version,
    currentVersion: version,
    currentVersionLabel: version,
    changelogPath: "/methodology/changelog/",
    asOf: 1_700_000_000,
    isCurrent: true,
  };
}


function canonicalPayloads(
  reportCardsPayload: unknown = makeReportCardsV9Response({ cards: [makeV9Card({ id: "usdc-circle" })] }),
  supply = 32_000_000_000,
) {
  return new Map<string, unknown>([
    [API_PATHS.stablecoins(), { peggedAssets: [makeStablecoin({
      id: "usdc-circle", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD",
      price: 1, circulating: { peggedUSD: supply },
    })] }],
    [API_PATHS.pegSummary(), {
      coins: [{
        id: "usdc-circle", symbol: "USDC", name: "USD Coin", pegType: "peggedUSD",
        pegCurrency: "USD", governance: "centralized", currentDeviationBps: 4,
        pegScore: 96, pegPct: 100, severityScore: 0, spreadPenalty: 0, eventCount: 0,
        worstDeviationBps: null, activeDepeg: false, lastEventAt: null,
        trackingSpanDays: 2000, methodologyVersion: "peg-v3",
      }],
      summary: null, methodology: methodology("peg-v3"),
    }],
    [API_PATHS.reportCardsV9(), reportCardsPayload],
    [
      API_PATHS.stressSignals(),
      {
        signals: { "usdc-circle": {
          score: 20, band: "low", signals: {}, computedAt: 1_700_000_000, methodologyVersion: "dews-v3",
        } },
        updatedAt: 1_700_000_000,
        methodology: methodology("dews-v3"),
      },
    ],
    [API_PATHS.dexLiquidity(), {}],
    [
      API_PATHS.yieldRankings(),
      {
        rankings: [],
        riskFreeRate: 0,
        scalingFactor: 1,
        medianApy: 0,
        updatedAt: 1_700_000_000,
        methodology: methodology("yield-v8"),
      },
    ],
    [API_PATHS.bluechipRatings(), {}],
  ]);
}

describe("canonical selector snapshot recomputation", () => {
  afterEach(() => {
    // The shared helper installs a global fetch spy by default.
    vi.unstubAllGlobals();
  });

  it("recomputes a verified selector snapshot from canonical V9 sources", async () => {
    const fetchMock = mockFetch(
      [...canonicalPayloads()].map(([path, body]) => ({
        match: `https://site-api.pharos.watch${path}`,
        body,
      })),
      { requireMatch: true, strictUrl: true },
    );

    const output = await recomputeVerifiedSelectorSnapshot(
      input,
      new Request("https://pharos.watch/selector-snapshot", { method: "POST" }),
      {
        SITE_API_ORIGIN: "https://site-api.pharos.watch",
        SITE_API_SHARED_SECRET: "test-secret",
      },
      1_700_000_000_000,
    );

    expect(output.provenance).toBe("pharos-verified");
    expect(output.recommended.map((coin) => coin.id)).toEqual(["usdc-circle"]);
    expect(output.snapshotSchemaVersion).toBe(3);
    expect(output.verification).toMatchObject({
      kind: "pharos-server-recomputed-v1",
      datasetHash: output.datasetHash,
      engineVersion: output.engineVersion,
    });
    const reportCardsFetch = fetchMock.getHistory().find(({ url }) => url.endsWith(API_PATHS.reportCardsV9()));
    expect(reportCardsFetch).toMatchObject({
      url: "https://site-api.pharos.watch/api/report-cards/v9",
      method: "GET",
    });
    expect(reportCardsFetch?.headers[SITE_DATA_PROXY_SECRET_HEADER.toLowerCase()]).toBe("test-secret");
  });

  it.each([
    [1, false, "selected-source", "ethereum", 6],
    [5, true, "selected-source", "ethereum", 6],
    [5, false, "alternate-lending", "arbitrum", 1],
  ] as const)("keeps canonical APY/native gates and verified evidence on the selected rail (%s, %s)", async (
    alternateApy, yieldNativeOnly, expectedSource, expectedChain, expectedExcess,
  ) => {
    const payloads = canonicalPayloads();
    payloads.set(API_PATHS.yieldRankings(), {
      rankings: [makeYieldRanking({
        apy30d: 10, benchmarkRate: 4, pharosYieldScore: 80,
        yieldType: "nav-appreciation",
        sourceRisk: {
          venueProtocol: "Issuer savings", venueChain: "ethereum", venueRiskTier: "low",
          deploymentPlace: "issuer-savings", sourceRiskScore: 10, observationCount30d: 30,
        },
        altSources: [makeAltYieldSource({
          sourceKey: "alternate-lending", apy30d: alternateApy,
          sourceRisk: {
            venueProtocol: "Lending venue", venueChain: "arbitrum", venueRiskTier: "high",
            deploymentPlace: "lending-market", sourceRiskScore: 70, observationCount30d: 2,
          },
        })],
      })],
      riskFreeRate: 4, scalingFactor: 1, medianApy: 10, updatedAt: 1_700_000_000,
      methodology: methodology("yield-v8"),
    });
    mockFetch([...payloads].map(([path, body]) => ({
      match: `https://site-api.pharos.watch${path}`, body,
    })), { requireMatch: true, strictUrl: true });
    const output = await recomputeVerifiedSelectorSnapshot(
      { ...input, profile: "yield", venuePreferences: ["lend"], minApy: 5, yieldNativeOnly },
      new Request("https://pharos.watch/selector-snapshot"),
      { SITE_API_ORIGIN: "https://site-api.pharos.watch", SITE_API_SHARED_SECRET: "test-secret" },
      1_700_000_000_000,
    );
    const rec = output.recommended[0]!;
    expect(rec.recommendedSource).toMatchObject({ sourceKey: expectedSource, chain: expectedChain });
    expect(rec.chainHints).toMatchObject({ topByYield: [expectedChain], primary: expectedChain });
    expect(rec.components.find((component) => component.key === "excessApy")?.rawValue).toBe(expectedExcess);
    expect(rec.components.find((component) => component.key === "sourceRiskInverted")?.rawValue)
      .toBe(expectedSource === "alternate-lending" ? 70 : 10);
    if (expectedSource === "alternate-lending") {
      expect(rec.recommendedSource?.pharosYieldScore).toBeNull();
      expect(rec.components.find((component) => component.key === "pharosYieldScore")?.rawValue).toBeNull();
      expect(rec.components.find((component) => component.key === "yieldVariance")?.rawValue).toBeNull();
      expect(rec.whyKeys).not.toContain("native-wrapper-rail");
      expect(rec.whyKeys).not.toContain("low-variance");
    }
    const replay = validateVerifiedSelectorSnapshot(JSON.parse(JSON.stringify(output)));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error(`Expected verified replay: ${replay.error}`);
    expect(replay.snapshot).toEqual(output);
    expect(computeSelectorSnapshotSid(replay.snapshot)).toBe(computeSelectorSnapshotSid(output));
  });

  it("changes selection when canonical supply falls below eligibility and accepts source metadata", async () => {
    for (const supply of [32_000_000_000, 4_000_000]) {
      mockFetch([...canonicalPayloads(undefined, supply)].map(([path, body]) => ({
        match: `https://site-api.pharos.watch${path}`,
        body: { ...(body as Record<string, unknown>), _meta: { ageSeconds: 0 } },
      })), { requireMatch: true, strictUrl: true });
      const output = await recomputeVerifiedSelectorSnapshot(
        input,
        new Request("https://pharos.watch/selector-snapshot"),
        { SITE_API_ORIGIN: "https://site-api.pharos.watch", SITE_API_SHARED_SECRET: "test-secret" },
        1_700_000_000_000,
      );
      expect(output.recommended.map((coin) => coin.id)).toEqual(supply > 5_000_000 ? ["usdc-circle"] : []);
    }
  });

  it("rejects missing canonical credentials before fetching", async () => {
    const fetchMock = mockFetch([], { requireMatch: true });
    await expect(recomputeVerifiedSelectorSnapshot(
      input,
      new Request("https://pharos.watch/selector-snapshot"),
      { SITE_API_ORIGIN: "https://site-api.pharos.watch" },
    )).rejects.toThrow("Canonical selector data lane is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unavailable canonical source rather than publishing partial selection", async () => {
    mockFetch([...canonicalPayloads()].map(([path, body]) => ({
      match: `https://site-api.pharos.watch${path}`,
      body,
      status: path === API_PATHS.stablecoins() ? 503 : 200,
    })), { requireMatch: true, strictUrl: true });
    await expect(recomputeVerifiedSelectorSnapshot(
      input,
      new Request("https://pharos.watch/selector-snapshot"),
      { SITE_API_ORIGIN: "https://site-api.pharos.watch", SITE_API_SHARED_SECRET: "test-secret" },
    )).rejects.toThrow("Canonical selector source unavailable: /api/stablecoins");
  });

  it("rejects a canonical source that does not satisfy the V9 report-card contract", async () => {
    mockFetch(
      [...canonicalPayloads({ cards: [] })].map(([path, body]) => ({
        match: `https://site-api.pharos.watch${path}`,
        body,
      })),
      { requireMatch: true, strictUrl: true },
    );

    await expect(
      recomputeVerifiedSelectorSnapshot(
        input,
        new Request("https://pharos.watch/selector-snapshot", { method: "POST" }),
        {
          SITE_API_ORIGIN: "https://site-api.pharos.watch",
          SITE_API_SHARED_SECRET: "test-secret",
        },
        1_700_000_000_000,
      ),
    ).rejects.toThrow("Canonical selector source contract failed: /api/report-cards/v9");

  });
});
