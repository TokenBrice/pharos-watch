import { describe, expect, it } from "vitest";
import {
  buildPipelineIntegrityModel,
  buildPipelineModeSummaries,
  buildPipelineModeUrl,
  buildPipelineQualityModel,
  collectPipelineLoaderErrors,
  parsePipelineMode,
} from "@/lib/pipeline-workspace-model";
import {
  degraded,
  makeHealthyStatusResponse,
  makeOperationalDependencyFailureStatusResponse,
  makePublicationFailureStatusResponse,
} from "@/test-utils/status-fixtures";

function withReadyQuality() {
  const base = makeHealthyStatusResponse();
  return degraded(base, {
    dataQuality: {
      ...base.dataQuality,
      blacklistTotal: 100,
      blacklistMissingAmounts: 0,
      blacklistMissingRatio: 0,
      blacklistRecentMissingAmounts: 0,
    },
  });
}

describe("pipeline URL modes", () => {
  it("parses only known modes and preserves unrelated URL state when updating", () => {
    expect(parsePipelineMode("?view=integrity&scope=all")).toBe("integrity");
    expect(parsePipelineMode("?view=not-a-mode")).toBeNull();
    expect(parsePipelineMode("?scope=all")).toBeNull();

    expect(
      buildPipelineModeUrl(
        { pathname: "/admin/pipeline/", search: "?scope=all", hash: "#signal" } as Location,
        "markets",
      ),
    ).toBe("/admin/pipeline/?scope=all&view=markets#signal");
  });
});

describe("pipeline quality model", () => {
  it("distinguishes a real zero from an unknown denominator", () => {
    const unknown = buildPipelineQualityModel(makeHealthyStatusResponse());
    const knownZero = buildPipelineQualityModel(withReadyQuality());

    expect(unknown.rows.find((row) => row.id === "blacklist-gaps")).toMatchObject({
      currentValue: "Unknown",
      state: "unknown",
    });
    expect(knownZero.rows.find((row) => row.id === "blacklist-gaps")).toMatchObject({
      currentValue: "0 (0.00%); 0 recent",
      state: "healthy",
    });
  });

  it("keeps inactive on-chain ratio gates Unknown instead of reporting healthy zeroes", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: {
        ...base.dataQuality,
        onchainSupplyTrackedCoins: 5,
        onchainSupplyDivergences: 0,
        onchainDivergenceRatio: 0,
        staleOnchainSupply: 0,
        onchainStaleRatio: 0,
      },
    });
    const rows = buildPipelineQualityModel(data).rows;

    expect(rows.find((row) => row.id === "onchain-divergences")).toMatchObject({
      currentValue: "Unknown",
      state: "unknown",
    });
    expect(rows.find((row) => row.id === "stale-onchain")?.stateDetail).toContain("Confidence floor is inactive");
  });

  it("builds dense threshold rows with critical state and explicit population", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: {
        ...base.dataQuality,
        totalStablecoins: 100,
        missingPrices: 50,
      },
    });
    const model = buildPipelineQualityModel(data);
    const missing = model.rows.find((row) => row.id === "missing-prices");

    expect(model.rows).toHaveLength(4);
    expect(missing).toMatchObject({
      currentValue: "50 (50.0%)",
      eligiblePopulation: "100 active stablecoins returned by the cache",
      warningThreshold: ">18%",
      staleThreshold: ">45%",
      state: "critical",
    });
  });

  it("does not let informational depegs or Integrity repair debt drive the Quality badge", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: {
        ...base.dataQuality,
        activeDepegStatus: "failed",
        repairDebt: {
          ...base.dataQuality.repairDebt,
          status: "present",
          openCount: 4,
        },
      },
    });
    const quality = buildPipelineModeSummaries(data).find((mode) => mode.id === "quality");

    expect(buildPipelineQualityModel(data).activeDepegs).toMatchObject({
      currentValue: "Unknown",
      unavailable: true,
    });
    expect(quality).toMatchObject({ severity: "healthy", issueCount: 0 });
  });

  it("counts only non-healthy threshold rows and reports their worst severity", () => {
    const base = withReadyQuality();
    const data = degraded(base, {
      dataQuality: { ...base.dataQuality, totalStablecoins: 100, missingPrices: 50 },
    });

    expect(buildPipelineModeSummaries(data).find((mode) => mode.id === "quality")).toMatchObject({
      issueCount: 1,
      severity: "critical",
    });
  });
});

describe("pipeline coverage summaries", () => {
  it("maps inactive loader errors to human labels while retaining raw keys and codes", () => {
    const base = makeHealthyStatusResponse();
    const data = degraded(base, {
      sectionErrors: {
        coingeckoPriceDiff: { code: "cg_query_failed", message: "Comparison timed out" },
        classificationWarnings: { code: "class_query_failed", message: "Classification query timed out" },
        dependencyHealth: { code: "dependency_query_failed", message: "Dependency inventory timed out" },
      },
    });

    expect(collectPipelineLoaderErrors(data)).toEqual([
      expect.objectContaining({ label: "CoinGecko comparison", rawKey: "coingeckoPriceDiff", code: "cg_query_failed" }),
      expect.objectContaining({
        label: "Classification warnings",
        rawKey: "classificationWarnings",
        code: "class_query_failed",
      }),
      expect.objectContaining({ label: "Dependency health", rawKey: "dependencyHealth" }),
    ]);
  });

  it("covers publication controls, publication failures, and dependency evidence in Integrity", () => {
    const dependencyData = makeOperationalDependencyFailureStatusResponse();
    const publicationData = makePublicationFailureStatusResponse();
    const data = degraded(dependencyData, {
      publicationHealth: publicationData.publicationHealth,
      dataQuality: {
        ...dependencyData.dataQuality,
        stablecoinPublication: {
          status: "incomplete",
          expectedActiveCount: 10,
          presentActiveCount: 8,
          waivedActiveCount: 1,
          missingActiveIds: ["missing-coin"],
          waivedActiveIds: ["waived-coin"],
          expiredWaiverIds: [],
          observedAt: dependencyData.timestamp,
        },
      },
    });
    const model = buildPipelineIntegrityModel(data);

    expect(model.controlRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Stablecoin publication coverage", state: "critical" }),
      ]),
    );
    expect(model.publicationRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "DEX Liquidity", rawCode: "dex-liquidity", state: "critical" }),
      ]),
    );
    expect(model.dependencyRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "Fixture market cache", rawCode: "fixture-market-cache", state: "critical" }),
      ]),
    );
  });
});
