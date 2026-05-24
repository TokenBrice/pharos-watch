import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StablecoinMeta } from "../../shared/types";
import type { RedemptionBackstopConfig } from "../../shared/lib/redemption-backstop-configs/shared";
import {
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

  it("separates pre-launch and frozen unconfigured coins from active gaps", () => {
    const activeCoins = [coin({ id: "usdc-circle" })];
    const preLaunchCoins = [coin({ id: "krw1-bdacs", status: "pre-launch" })];
    const frozenCoins = [coin({ id: "buck-buck-assets", status: "frozen" })];

    const audit = generateRedemptionCoverageAudit({
      trackedCoins: [...activeCoins, ...preLaunchCoins, ...frozenCoins],
      activeCoins,
      preLaunchCoins,
      frozenCoins,
      configs: { "usdc-circle": configuredRoute },
    });

    expect(audit.summary.activeUnconfigured).toBe(0);
    expect(audit.summary.preLaunchUnconfigured).toBe(1);
    expect(audit.summary.frozenUnconfigured).toBe(1);
    expect(audit.lifecycleExcludedUnconfigured).toEqual([
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
      trackedCoins: [coin({ id: "mmxn-moneta-digital" })],
      activeCoins: [coin({ id: "mmxn-moneta-digital" })],
      configs: {},
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    const markdown = renderRedemptionCoverageAuditMarkdown(audit);

    expect(markdown).toContain("## Active Unconfigured Gaps");
    expect(markdown).toContain(
      "id | lifecycle | current disposition | classification source | blocker | evidence needed | allowed route family if proven",
    );
    expect(markdown).toContain("mmxn-moneta-digital | active | needs-research (issuer-terms-missing) | curated");
  });

  it("parses CLI format and report options", () => {
    expect(parseArgs(["--json", "--strict-active-gaps", "--report", "agents/audit.json"])).toEqual({
      format: "json",
      reportPath: "agents/audit.json",
      strictActiveGaps: true,
    });
    expect(() => parseArgs(["--report"])).toThrow("--report requires a path");
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
  });
});
