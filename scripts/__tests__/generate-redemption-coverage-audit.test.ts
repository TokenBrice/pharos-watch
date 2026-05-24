import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "../../shared/types";
import type { RedemptionBackstopConfig } from "../../shared/lib/redemption-backstop-configs/shared";
import {
  evaluateRedemptionCoverageAudit,
  generateRedemptionCoverageAudit,
  parseArgs,
  renderRedemptionCoverageAuditMarkdown,
  runCli,
} from "../maintenance/generate-redemption-coverage-audit";

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
    links: input.links ?? [{ label: "Website", url: `https://example.com/${input.id}` }],
    ...(input.status ? { status: input.status } : {}),
    ...(input.variantOf ? { variantOf: input.variantOf } : {}),
  };
}

const configuredRoute: RedemptionBackstopConfig = {
  routeFamily: "offchain-issuer",
  accessModel: "issuer-api",
  settlementModel: "same-day",
  executionModel: "rules-based-nav",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full", confidence: "documented-bound" },
  costModel: { kind: "dynamic-or-unclear", confidence: "undisclosed-reviewed" },
  reviewedAt: "2026-05-12",
};

const heuristicRoute: RedemptionBackstopConfig = {
  ...configuredRoute,
  routeFamily: "queue-redeem",
  capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "heuristic" },
};

describe("generate-redemption-coverage-audit", () => {
  it("classifies active unconfigured coins with V4 reason-code placeholders", () => {
    const activeCoins = [
      coin({ id: "usdc-circle" }),
      coin({ id: "mmxn-moneta-digital", symbol: "MMXN" }),
      coin({
        id: "iusd-initia",
        flags: {
          backing: "rwa-backed",
          pegCurrency: "USD",
          governance: "centralized-dependent",
          yieldBearing: false,
          rwa: false,
          navToken: true,
        },
      }),
      coin({
        id: "random-crypto",
        flags: {
          backing: "crypto-backed",
          pegCurrency: "USD",
          governance: "decentralized",
          yieldBearing: false,
          rwa: false,
          navToken: false,
        },
      }),
    ];

    const audit = generateRedemptionCoverageAudit({
      trackedCoins: activeCoins,
      activeCoins,
      configs: { "usdc-circle": configuredRoute },
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(audit.summary.activeUnconfigured).toBe(3);
    expect(audit.summary.activeUnclassified).toBe(0);
    expect(audit.summary.activeDefaultClassified).toBe(1);
    expect(audit.dispositionCounts).toEqual({
      add: 0,
      defer: 0,
      "hard-reject": 0,
      "needs-research": 3,
    });
    expect(audit.activeUnconfigured).toEqual([
      expect.objectContaining({
        id: "iusd-initia",
        disposition: "needs-research",
        reasonCode: "capacity-unpublished",
        classificationSource: "curated",
        allowedRouteFamilyIfProven: "queue-redeem",
      }),
      expect.objectContaining({
        id: "mmxn-moneta-digital",
        disposition: "needs-research",
        reasonCode: "issuer-terms-missing",
        classificationSource: "curated",
        allowedRouteFamilyIfProven: "offchain-issuer",
      }),
      expect.objectContaining({
        id: "random-crypto",
        disposition: "needs-research",
        reasonCode: "source-review-needed",
        classificationSource: "default-inferred",
        allowedRouteFamilyIfProven: "collateral-redeem",
      }),
    ]);
  });

  it("pins curated defer, hard-reject, research, and default backlog rows", () => {
    const cryptoFlags = {
      backing: "crypto-backed",
      pegCurrency: "USD",
      governance: "decentralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    } satisfies StablecoinMeta["flags"];
    const activeCoins = [
      coin({ id: "mim-abracadabra", flags: cryptoFlags }),
      coin({ id: "frax-frax", flags: cryptoFlags }),
      coin({ id: "hollar-hydrated", flags: cryptoFlags }),
      coin({ id: "unreviewed-crypto", flags: cryptoFlags }),
    ];

    const audit = generateRedemptionCoverageAudit({
      trackedCoins: activeCoins,
      activeCoins,
      configs: {},
    });

    expect(audit.dispositionCounts).toEqual({
      add: 0,
      defer: 1,
      "hard-reject": 1,
      "needs-research": 2,
    });
    expect(audit.summary.activeUnclassified).toBe(0);
    expect(audit.summary.activeDefaultClassified).toBe(1);
    expect(audit.activeUnconfigured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "mim-abracadabra",
          disposition: "defer",
          reasonCode: "no-holder-route",
          classificationSource: "curated",
        }),
        expect.objectContaining({
          id: "frax-frax",
          disposition: "hard-reject",
          reasonCode: "no-holder-route",
          classificationSource: "curated",
          allowedRouteFamilyIfProven: null,
        }),
        expect.objectContaining({
          id: "hollar-hydrated",
          disposition: "needs-research",
          reasonCode: "capacity-unpublished",
          classificationSource: "curated",
        }),
        expect.objectContaining({
          id: "unreviewed-crypto",
          disposition: "needs-research",
          reasonCode: "source-review-needed",
          classificationSource: "default-inferred",
          allowedRouteFamilyIfProven: "collateral-redeem",
        }),
      ]),
    );
  });

  it("separates pre-launch and frozen unconfigured coins from active gaps", () => {
    const activeCoins = [coin({ id: "usdc-circle" })];
    const preLaunchCoins = [coin({ id: "krw1-bdacs", status: "pre-launch" }), coin({ id: "brd-volpon" })];
    const frozenCoins = [coin({ id: "buck-buck-assets", status: "frozen" }), coin({ id: "statusless-frozen" })];

    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [...activeCoins, ...preLaunchCoins, ...frozenCoins],
      activeCoins,
      preLaunchCoins,
      frozenCoins,
      configs: { "usdc-circle": configuredRoute },
    });

    expect(audit.summary.activeUnconfigured).toBe(0);
    expect(audit.summary.preLaunchUnconfigured).toBe(2);
    expect(audit.summary.frozenUnconfigured).toBe(2);
    expect(audit.lifecycleExcludedUnconfigured).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "brd-volpon",
          lifecycle: "pre-launch",
          disposition: "defer",
          reasonCode: "pre-launch",
        }),
        expect.objectContaining({
          id: "statusless-frozen",
          lifecycle: "frozen",
          disposition: "hard-reject",
          reasonCode: "frozen",
        }),
      ]),
    );
    expect(audit.lifecycleExcludedUnconfigured).toHaveLength(4);
    expect(audit.lifecycleExcludedUnconfigured).toEqual([
      expect.objectContaining({
        id: "brd-volpon",
      }),
      expect.objectContaining({
        id: "buck-buck-assets",
        lifecycle: "frozen",
        disposition: "hard-reject",
        reasonCode: "frozen",
      }),
      expect.objectContaining({
        id: "krw1-bdacs",
        lifecycle: "pre-launch",
        disposition: "defer",
        reasonCode: "pre-launch",
      }),
      expect.objectContaining({
        id: "statusless-frozen",
      }),
    ]);
  });

  it("adds configured heuristic routes to the V4-43 review queue", () => {
    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [coin({ id: "usdc-circle" }), coin({ id: "pmusd-precious-metals" })],
      activeCoins: [coin({ id: "usdc-circle" }), coin({ id: "pmusd-precious-metals" })],
      configs: {
        "usdc-circle": configuredRoute,
        "pmusd-precious-metals": heuristicRoute,
      },
    });

    expect(audit.summary.heuristicConfiguredRoutes).toBe(1);
    expect(audit.heuristicConfiguredRoutes).toEqual([
      expect.objectContaining({
        id: "pmusd-precious-metals",
        routeFamily: "queue-redeem",
        capacityModel: "supply-ratio",
      }),
    ]);
  });

  it("renders the expected reviewer tables", () => {
    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [
        coin({
          id: "mmxn-moneta-digital",
          links: [{ label: "Docs", url: "https://example.com/source|with-pipe" }],
        }),
      ],
      activeCoins: [
        coin({
          id: "mmxn-moneta-digital",
          links: [{ label: "Docs", url: "https://example.com/source|with-pipe" }],
        }),
      ],
      configs: {},
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    const markdown = renderRedemptionCoverageAuditMarkdown(audit);

    expect(markdown).toContain("## Active Unconfigured Gaps");
    expect(markdown).toContain(
      "id | lifecycle | current disposition | classification source | blocker | evidence needed | allowed route family if proven",
    );
    expect(markdown).toContain("mmxn-moneta-digital | active | needs-research (issuer-terms-missing) | curated");
    expect(markdown).toContain("https://example.com/source\\|with-pipe");
  });

  it("parses CLI format and report options", () => {
    expect(parseArgs(["--json", "--strict-active-gaps", "--check", "--report", "agents/audit.json"])).toEqual({
      format: "json",
      reportPath: "agents/audit.json",
      strictActiveGaps: true,
      check: true,
    });
    expect(() => parseArgs(["--report"])).toThrow("--report requires a path");
    expect(() => parseArgs(["--unknown"])).toThrow("Unknown argument: --unknown");
  });

  it("strict CLI mode fails default-inferred active gaps but allows curated active gaps", () => {
    const cwd = mkdtempSync(join(tmpdir(), "redemption-coverage-audit-"));
    const defaultGapAudit = () =>
      generateRedemptionCoverageAudit({
        trackedCoins: [coin({ id: "random-crypto" })],
        activeCoins: [
          coin({
            id: "random-crypto",
            flags: {
              backing: "crypto-backed",
              pegCurrency: "USD",
              governance: "decentralized",
              yieldBearing: false,
              rwa: false,
              navToken: false,
            },
          }),
        ],
        configs: {},
      });
    const curatedGapAudit = () =>
      generateRedemptionCoverageAudit({
        trackedCoins: [coin({ id: "mmxn-moneta-digital", symbol: "MMXN" })],
        activeCoins: [coin({ id: "mmxn-moneta-digital", symbol: "MMXN" })],
        configs: {},
      });

    expect(runCli(["--json", "--strict-active-gaps", "--report", "default.json"], cwd, defaultGapAudit)).toBe(1);
    expect(runCli(["--json", "--strict-active-gaps", "--report", "curated.json"], cwd, curatedGapAudit)).toBe(0);
    const defaultReport = JSON.parse(readFileSync(join(cwd, "default.json"), "utf8")) as {
      summary: { activeDefaultClassified: number };
    };
    expect(defaultReport.summary.activeDefaultClassified).toBe(1);
  });

  it("check mode ratchets the default backlog without requiring strict-zero immediately", () => {
    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [coin({ id: "random-crypto" })],
      activeCoins: [
        coin({
          id: "random-crypto",
          flags: {
            backing: "crypto-backed",
            pegCurrency: "USD",
            governance: "decentralized",
            yieldBearing: false,
            rwa: false,
            navToken: false,
          },
        }),
      ],
      configs: {},
    });

    expect(
      evaluateRedemptionCoverageAudit(audit, {
        baseline: { activeDefaultClassified: 1, activeUnconfigured: 1, heuristicConfiguredRoutes: 0 },
      }),
    ).toEqual([]);
    expect(
      evaluateRedemptionCoverageAudit(audit, {
        baseline: { activeDefaultClassified: 0, activeUnconfigured: 1, heuristicConfiguredRoutes: 0 },
      }),
    ).toEqual([
      expect.objectContaining({
        code: "active-default-classified-ratchet-regressed",
      }),
    ]);
    expect(evaluateRedemptionCoverageAudit(audit, { strictActiveGaps: true })).toEqual([
      expect.objectContaining({
        code: "active-default-classified-gaps",
      }),
    ]);
  });

  it("check mode ratchets active unconfigured and heuristic route growth", () => {
    const activeGapAudit = generateRedemptionCoverageAudit({
      trackedCoins: [coin({ id: "random-crypto" })],
      activeCoins: [coin({ id: "random-crypto" })],
      configs: {},
    });
    const heuristicAudit = generateRedemptionCoverageAudit({
      trackedCoins: [coin({ id: "usdc-circle" }), coin({ id: "pmusd-precious-metals" })],
      activeCoins: [coin({ id: "usdc-circle" }), coin({ id: "pmusd-precious-metals" })],
      configs: {
        "usdc-circle": configuredRoute,
        "pmusd-precious-metals": heuristicRoute,
      },
    });

    expect(
      evaluateRedemptionCoverageAudit(activeGapAudit, {
        baseline: { activeDefaultClassified: 1, activeUnconfigured: 0, heuristicConfiguredRoutes: 0 },
      }),
    ).toEqual([
      expect.objectContaining({
        code: "active-unconfigured-ratchet-regressed",
      }),
    ]);
    expect(
      evaluateRedemptionCoverageAudit(heuristicAudit, {
        baseline: { activeDefaultClassified: 0, activeUnconfigured: 0, heuristicConfiguredRoutes: 0 },
      }),
    ).toEqual([
      expect.objectContaining({
        code: "heuristic-configured-ratchet-regressed",
      }),
    ]);
  });

  it("writes nested CLI reports with the selected output format", () => {
    const cwd = mkdtempSync(join(tmpdir(), "redemption-coverage-audit-report-"));
    const status = runCli(["--json", "--report", "nested/reports/audit.json"], cwd, () =>
      generateRedemptionCoverageAudit({
        trackedCoins: [coin({ id: "usdc-circle" })],
        activeCoins: [coin({ id: "usdc-circle" })],
        configs: { "usdc-circle": configuredRoute },
        generatedAt: "2026-05-12T00:00:00.000Z",
      }),
    );

    expect(status).toBe(0);
    const report = JSON.parse(readFileSync(join(cwd, "nested/reports/audit.json"), "utf8")) as {
      generatedAt: string;
      summary: { activeConfigured: number; activeUnconfigured: number };
    };
    expect(report.generatedAt).toBe("2026-05-12T00:00:00.000Z");
    expect(report.summary.activeConfigured).toBe(1);
    expect(report.summary.activeUnconfigured).toBe(0);
  });
});
