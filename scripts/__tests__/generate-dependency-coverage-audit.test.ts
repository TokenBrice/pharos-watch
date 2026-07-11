import { describe, expect, it, vi } from "vitest";
import type { StablecoinMeta } from "../../shared/types";
import {
  buildDependencyCoverageAudit,
  evaluateDependencyCoverageBaseline,
  parseArgs,
  renderDependencyCoverageAuditMarkdown,
  runCli,
} from "../maintenance/generate-dependency-coverage-audit";

function coin(input: Partial<StablecoinMeta> & Pick<StablecoinMeta, "id">): StablecoinMeta {
  return {
    id: input.id,
    name: input.name ?? input.id,
    symbol: input.symbol ?? input.id.toUpperCase(),
    flags: input.flags ?? {
      backing: "rwa-backed",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    collateral: input.collateral ?? "Fixture collateral",
    pegMechanism: input.pegMechanism ?? "Fixture mechanism",
    ...(input.contracts ? { contracts: input.contracts } : {}),
    ...(input.tradedContracts ? { tradedContracts: input.tradedContracts } : {}),
    ...(input.reserves ? { reserves: input.reserves } : {}),
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
    ...(input.variantOf ? { variantOf: input.variantOf } : {}),
  };
}

const activeCoins: StablecoinMeta[] = [
  coin({ id: "usdc-circle", symbol: "USDC", name: "USD Coin" }),
  coin({ id: "usdt-tether", symbol: "USDT", name: "Tether USD" }),
  coin({
    id: "wrap-usdc",
    symbol: "wUSDC",
    reserves: [{ name: "USDC", pct: 100, risk: "low", coinId: "usdc-circle" }],
  }),
  coin({
    id: "manual-usdt",
    symbol: "mUSDT",
    dependencies: [{ id: "usdt-tether", weight: 0.5, type: "mechanism" }],
  }),
  coin({
    id: "cash-only",
    symbol: "CASH",
    reserves: [
      { name: "Cash", pct: 90, risk: "very-low" },
      { name: "Stablecoin basket", pct: 10, risk: "low", depType: "mechanism" },
    ],
  }),
  coin({
    id: "lone-high",
    symbol: "LONE",
    name: "Lone High",
    contracts: [{ chain: "base", address: "0x0000000000000000000000000000000000000001", decimals: 18 }],
  }),
];

const stablecoinsPayload = {
  peggedAssets: [
    { id: "lone-high", circulating: { peggedUSD: 50_000_000 } },
    { id: "cash-only", circulating: { peggedUSD: 20_000_000 } },
    { id: "manual-usdt", circulating: { peggedUSD: 10_000_000 } },
    { id: "wrap-usdc", circulating: { peggedUSD: 5_000_000 } },
    { id: "usdt-tether", circulating: { peggedUSD: 4_000_000 } },
    { id: "usdc-circle", circulating: { peggedUSD: 3_000_000 } },
  ],
};

describe("generate-dependency-coverage-audit", () => {
  it("counts static graph coverage and reserve/dependency audit rows", () => {
    const audit = buildDependencyCoverageAudit({
      activeCoins,
      stablecoins: stablecoinsPayload,
      generatedAt: "2026-05-24T00:00:00.000Z",
    });

    expect(audit.summary).toMatchObject({
      activeCount: 6,
      staticEdgeCount: 2,
      staticActiveEdgeCount: 2,
      staticParticipantCount: 4,
      staticDependentCount: 2,
      staticUpstreamOnlyCount: 2,
      manualOnlyDependencyCount: 1,
      reserveSlicesMissingCoinId: 2,
      depTypeWithoutCoinIdWarnings: 1,
      missingCandidateCount: 2,
      l2beatDeploymentContextCount: 1,
      l2beatLayer3DeploymentContextCount: 0,
      l2beatUnderReviewDeploymentContextCount: 0,
      missingCandidateGraphSource: "static",
      missingCandidateRankSource: "stablecoin-api-market-cap",
    });
    expect(audit.manualOnlyDependencies).toEqual([
      {
        coinId: "manual-usdt",
        symbol: "mUSDT",
        dependencyId: "usdt-tether",
        dependencyType: "mechanism",
        weight: 0.5,
      },
    ]);
    expect(audit.depTypeWithoutCoinIdWarnings).toEqual([
      expect.objectContaining({
        coinId: "cash-only",
        reserveIndex: 1,
        reserveName: "Stablecoin basket",
        depType: "mechanism",
      }),
    ]);
    expect(audit.highestMarketCapMissingCandidates.map((row) => row.coinId)).toEqual([
      "lone-high",
      "cash-only",
    ]);
    expect(audit.l2beatDeploymentContext).toEqual([
      expect.objectContaining({
        coinId: "lone-high",
        chainId: "base",
        projectId: "base",
        layer: "layer2",
        hostChain: "Ethereum",
      }),
    ]);
  });

  it("uses report-card graph input when ranking missing runtime candidates", () => {
    const audit = buildDependencyCoverageAudit({
      activeCoins,
      stablecoins: stablecoinsPayload,
      reportCards: {
        dependencyGraph: {
          edges: [{ from: "usdc-circle", to: "wrap-usdc", weight: 1, type: "collateral" }],
        },
      },
    });

    expect(audit.summary).toMatchObject({
      reportCardEdgeCount: 1,
      reportCardParticipantCount: 2,
      reportCardDependentCount: 1,
      reportCardUpstreamOnlyCount: 1,
      missingCandidateGraphSource: "report-card",
      missingCandidateCount: 4,
    });
    expect(audit.highestMarketCapMissingCandidates.map((row) => row.coinId)).toEqual([
      "lone-high",
      "cash-only",
      "manual-usdt",
      "usdt-tether",
    ]);
  });

  it("renders the reviewer-facing sections", () => {
    const audit = buildDependencyCoverageAudit({
      activeCoins,
      stablecoins: stablecoinsPayload,
      generatedAt: "2026-05-24T00:00:00.000Z",
    });

    const markdown = renderDependencyCoverageAuditMarkdown(audit);

    expect(markdown).toContain("# Dependency Coverage Audit");
    expect(markdown).toContain("- Static dependency edges: 2");
    expect(markdown).toContain("## Highest-Market-Cap Missing Candidates");
    expect(markdown).toContain("LONE (lone-high)");
    expect(markdown).toContain("## depType Without coinId Warnings");
    expect(markdown).toContain("## L2BEAT Deployment Context");
    expect(markdown).toContain("Base Chain (base)");
  });

  it("evaluates the light ratchet baseline", () => {
    const audit = buildDependencyCoverageAudit({ activeCoins });

    expect(evaluateDependencyCoverageBaseline(audit, {
      staticEdgeCount: 2,
      participantCount: 4,
      dependentCount: 2,
      reserveSlicesMissingCoinId: 2,
      depTypeWithoutCoinIdWarnings: 1,
    })).toEqual([]);
    expect(evaluateDependencyCoverageBaseline(audit, {
      staticEdgeCount: 3,
      participantCount: 5,
      dependentCount: 3,
      reserveSlicesMissingCoinId: 1,
      depTypeWithoutCoinIdWarnings: 0,
    })).toEqual([
      "static edge count regressed from 3 to 2",
      "static participant count regressed from 5 to 4",
      "static dependent count regressed from 3 to 2",
      "reserve slices missing coinId increased from 1 to 2",
      "depType without coinId warnings increased from 0 to 1",
    ]);
  });

  it("parses CLI options", () => {
    expect(parseArgs([
      "--report-cards",
      "agents/report-cards.json",
      "--stablecoins",
      "agents/stablecoins.json",
      "--json",
      "--check",
      "--baseline",
      "agents/baseline.json",
    ])).toMatchObject({
      reportCardsPath: "agents/report-cards.json",
      stablecoinsPath: "agents/stablecoins.json",
      format: "json",
      check: true,
      baselinePath: "agents/baseline.json",
    });
    expect(() => parseArgs(["--prod", "--api-base", "https://api.example.test"])).toThrow(
      "Choose only one of --prod or --api-base.",
    );
  });

  it("fails on explicit missing input files", async () => {
    await expect(
      runCli(["--report-cards", "agents/missing-report-cards.json"], process.cwd()),
    ).rejects.toThrow("--report-cards file not found");
    await expect(
      runCli(["--stablecoins", "agents/missing-stablecoins.json"], process.cwd()),
    ).rejects.toThrow("--stablecoins file not found");
  });

  it("sends site-origin headers when fetching prod site-data", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const href = String(url);
      return new Response(
        JSON.stringify(href.includes("report-cards")
          ? { dependencyGraph: { edges: [] } }
          : { peggedAssets: [] }),
        { status: 200 },
      );
    });
    const fetchImpl: typeof fetch = fetchMock;
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(runCli(["--prod", "--json", "--generated-at", "2026-05-24T00:00:00.000Z"], process.cwd(), fetchImpl))
        .resolves.toBe(0);
    } finally {
      stdout.mockRestore();
    }

    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toMatchObject({
        headers: expect.objectContaining({
          Origin: "https://pharos.watch",
          Referer: "https://pharos.watch/coverage/",
        }),
      });
    }
  });
});
