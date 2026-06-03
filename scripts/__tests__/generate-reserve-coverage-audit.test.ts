import { describe, expect, it, vi } from "vitest";
import type { LiveReserveAdapterKey, LiveReservesConfig } from "../../shared/types/live-reserves";
import type { StablecoinMeta } from "../../shared/types";
import {
  buildReserveCoverageAudit,
  parseArgs,
  renderReserveCoverageAuditMarkdown,
  runCli,
} from "../maintenance/generate-reserve-coverage-audit";

function liveConfig(adapter: LiveReserveAdapterKey): LiveReservesConfig {
  return {
    adapter,
    version: 1,
    semantics: "collateral-mix",
    display: { url: `https://example.com/${adapter}` },
    inputs: {
      primary: { kind: "http-json", url: `https://example.com/${adapter}.json` },
    },
    params: {},
  };
}

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
    ...(input.reserves ? { reserves: input.reserves } : {}),
    ...(input.liveReservesConfig ? { liveReservesConfig: input.liveReservesConfig } : {}),
  };
}

const activeCoins = [
  coin({
    id: "live-a",
    symbol: "LIVA",
    reserves: [
      { name: "USDC", pct: 60, risk: "low", coinId: "usdc-circle" },
      { name: "Cash", pct: 40, risk: "very-low" },
    ],
    liveReservesConfig: liveConfig("accountable"),
  }),
  coin({
    id: "live-b",
    symbol: "LIVB",
    reserves: [
      { name: "Treasuries", pct: 55, risk: "very-low" },
      { name: "Stablecoin basket", pct: 9, risk: "low" },
    ],
    liveReservesConfig: liveConfig("curated-validated"),
  }),
  coin({
    id: "live-c",
    symbol: "LIVC",
    reserves: [{ name: "Single token", pct: 100, risk: "low", coinId: "usdt-tether" }],
    liveReservesConfig: liveConfig("single-asset"),
  }),
  coin({ id: "plain", symbol: "PLN", reserves: [{ name: "Cash", pct: 100, risk: "very-low" }] }),
] satisfies StablecoinMeta[];

describe("generate-reserve-coverage-audit", () => {
  it("counts reserve coverage, evidence buckets, and score-grade gaps", () => {
    const audit = buildReserveCoverageAudit({
      trackedCoins: [...activeCoins, coin({ id: "pre" }), coin({ id: "frozen" })],
      activeCoins,
      preLaunchCoins: [coin({ id: "pre" })],
      frozenCoins: [coin({ id: "frozen" })],
      reportCards: {
        cards: [
          { id: "live-a", rawInputs: { collateralFromLive: true, dependencyFromLive: true } },
          { id: "live-b", rawInputs: { collateralFromLive: false, dependencyFromLive: false } },
          { id: "live-c", rawInputs: { collateralFromLive: false, dependencyFromLive: false } },
          { id: "plain", rawInputs: { collateralFromLive: false, dependencyFromLive: false } },
          { id: "defunct", isDefunct: true, rawInputs: { collateralFromLive: true, dependencyFromLive: true } },
        ],
      },
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(audit.summary).toMatchObject({
      trackedCount: 6,
      activeCount: 4,
      preLaunchCount: 1,
      frozenCount: 1,
      activeWithCuratedReserves: 4,
      activeReserveSliceCount: 6,
      activeLinkedReserveSliceCount: 2,
      activeUnlinkedReserveSliceCount: 4,
      activeUnlinkedReserveSlicePctGte10Count: 3,
      activeUnlinkedReserveSlicePctGte50Count: 2,
      activeWithLinkedReserveSliceCount: 2,
      liveEnabledActiveCount: 3,
      reportCardActiveCount: 4,
      collateralFromLiveActiveCount: 1,
      dependencyFromLiveActiveCount: 1,
      independentConfiguredButNotScoreGradeCount: 0,
    });
    expect(audit.liveEnabledByEvidenceClass).toEqual({
      independent: 1,
      "static-validated": 1,
      "weak-live-probe": 1,
    });
    expect(audit.independentConfiguredButNotScoreGradeIds).toEqual([]);
  });

  it("renders missing score-grade independent configs when report cards are supplied", () => {
    const audit = buildReserveCoverageAudit({
      activeCoins,
      reportCards: { cards: activeCoins.map((entry) => ({ id: entry.id, rawInputs: {} })) },
      generatedAt: "2026-06-03T00:00:00.000Z",
    });

    expect(audit.independentConfiguredButNotScoreGradeIds).toEqual(["live-a"]);

    const markdown = renderReserveCoverageAuditMarkdown(audit);
    expect(markdown).toContain("# Reserve Coverage Audit");
    expect(markdown).toContain("- Live-enabled independent: 1");
    expect(markdown).toContain("- live-a");
  });

  it("parses CLI options", () => {
    expect(parseArgs([
      "--report-cards",
      "agents/report-cards.json",
      "--json",
      "--report",
      "agents/reserve-coverage.json",
      "--generated-at",
      "2026-06-03T00:00:00.000Z",
    ])).toMatchObject({
      reportCardsPath: "agents/report-cards.json",
      format: "json",
      reportPath: "agents/reserve-coverage.json",
      generatedAt: "2026-06-03T00:00:00.000Z",
    });
    expect(() => parseArgs(["--prod", "--api-base", "https://api.example.test"])).toThrow(
      "Choose only one of --prod or --api-base.",
    );
  });

  it("sends site-origin headers when fetching prod report cards", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ cards: [] }), { status: 200 }));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    try {
      await expect(runCli([
        "--prod",
        "--json",
        "--generated-at",
        "2026-06-03T00:00:00.000Z",
      ], process.cwd(), fetchMock as unknown as typeof fetch)).resolves.toBe(0);
    } finally {
      stdout.mockRestore();
    }

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pharos.watch/_site-data/report-cards",
      expect.objectContaining({
        headers: expect.objectContaining({
          Origin: "https://pharos.watch",
          Referer: "https://pharos.watch/coverage/",
        }),
      }),
    );
  });
});
