// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  BRIDGE_THIRD_PARTY_TIERS,
  BRIDGE_TIER_LABELS,
  BRIDGE_TIER_POLICY_ORDER,
  CONTROL_COMPONENT_ROLE_LABELS,
  getBridgeTierLabel,
} from "@shared/lib/classification";
import type { BridgeRouteRiskTier } from "@shared/types";
import { findSummaryBudgetViolations } from "@shared/lib/summary-budget";
import {
  BridgingDeploymentsModule,
  buildBridgingDeploymentsIndexChip,
  buildBridgingDeploymentsVerdict,
  resolveBridgingDeploymentsForm,
} from "../bridging-card";
import type { FailureDomainRow, FailureDomainsView } from "@/lib/failure-domains";
import type { ControlComponentRoles, ControlStripComponent } from "@/lib/pillar-evidence-strips";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";
import type { BridgeRouteClientRow, BridgeRouteRiskClientSummary } from "@/lib/stablecoin-detail-bridge-client";

const AUTHORED_SUMMARY = "Reviewer narrative about the route inventory.";

function route(
  key: string,
  chainId: string,
  overrides: Partial<BridgeRouteClientRow> = {},
): BridgeRouteClientRow {
  const tierKey = overrides.tierKey ?? "issuer-native-burn-mint";
  return {
    key,
    chainId,
    chainLabel: chainId.charAt(0).toUpperCase() + chainId.slice(1),
    tierKey,
    tierLabel: BRIDGE_TIER_LABELS[tierKey],
    protocolLabel: "Bridge",
    protocolKey: null,
    reviewed: true,
    controlComponentKey: null,
    ...overrides,
  };
}

/** Mirrors `projectBridgeRouteRiskClientSummary`: counts and labels come from the same routes. */
function summaryOf(
  rows: BridgeRouteClientRow[],
  overrides: Partial<BridgeRouteRiskClientSummary> = {},
): BridgeRouteRiskClientSummary {
  const chainCount = overrides.chainCount ?? new Set(rows.map((row) => row.chainId)).size;
  const routes = rows.map((row) => ({ ...row, tierLabel: getBridgeTierLabel(row.tierKey, chainCount) }));
  const reviewed = routes.filter((row) => row.reviewed);
  const tierCounts: Partial<Record<BridgeRouteRiskTier, number>> = {};
  for (const row of reviewed) tierCounts[row.tierKey] = (tierCounts[row.tierKey] ?? 0) + 1;
  const weakest = BRIDGE_TIER_POLICY_ORDER.filter((tier) => (tierCounts[tier] ?? 0) > 0).at(-1) ?? null;
  const authoredTier = overrides.authoredTier ?? weakest ?? "single-chain-or-native";
  return {
    authoredTier,
    authoredTierLabel: getBridgeTierLabel(authoredTier, chainCount),
    weakestRouteTier: weakest,
    summary: AUTHORED_SUMMARY,
    reviewedAt: "2026-09-04",
    confidence: "verified",
    confidenceLabel: "Verified",
    routeCount: routes.length,
    unresolvedRouteCount: routes.length - reviewed.length,
    chainCount,
    thirdPartyRouteCount: reviewed.filter((row) => BRIDGE_THIRD_PARTY_TIERS[row.tierKey]).length,
    tierCounts,
    homeChainId: "ethereum",
    routes,
    routesTruncated: 0,
    sources: [{ label: "Issuer bridge docs", url: "https://example.com/bridge" }],
    ...overrides,
  };
}

function bridgeKey(row: BridgeRouteClientRow): string {
  return `bridge:${row.key}:bridge-meta:${row.chainId}`;
}

function component(
  key: string,
  kind: ControlStripComponent["kind"],
  score: number | null,
  role: ControlStripComponent["role"],
  overrides: Partial<ControlStripComponent> = {},
): ControlStripComponent {
  return { key, label: key, kind, score, posture: "reviewed", postureLabel: "Reviewed", role, tone: "neutral", ...overrides };
}

function rolesOf(components: ControlStripComponent[], minimum: number | null): ControlComponentRoles {
  return { minimum, evaluatedScore: minimum, adjusted: false, components };
}

function domainRow(overrides: Partial<FailureDomainRow> & Pick<FailureDomainRow, "key" | "label">): FailureDomainRow {
  return {
    kind: "bridge",
    memberCount: 1,
    exposureShare: null,
    modeledExposureShare: null,
    adjustmentPoints: 0,
    resolved: false,
    reason: "Shared messaging layer.",
    span: { chainIds: [], routeKeys: [], protocolKeys: [] },
    ...overrides,
  };
}

function legendCounts(container: HTMLElement): number[] {
  return [...container.querySelectorAll("[data-legend-count]")].map((node) => Number(node.textContent));
}

const NATIVE = route("ethereum:0xe", "ethereum", { protocolLabel: null, tierKey: "single-chain-or-native" });

/** USDe shape: a native home chain and 31 OFT routes whose bridge components sit outside the eligible set. */
function usdeShape() {
  const oft = Array.from({ length: 31 }, (_, index) =>
    route(`chain${index}:0x${index}`, `chain${index}`, { tierKey: "external-lock-mint" }),
  );
  const summary = summaryOf([NATIVE, ...oft]);
  const roles = rolesOf([
    component("oracle", "oracle", 45, "limiting"),
    component("mint", "mint", 68, "eligible"),
    ...oft.map((row) => component(bridgeKey(row), "bridge", 45, "diagnostic", { posture: "external-lock-mint" })),
  ], 45);
  return { summary, roles };
}

/** USTB shape: native routes plus the engine's unbound `bridge:unverified` fallback at the Control minimum. */
function ustbShape() {
  const summary = summaryOf([
    NATIVE,
    route("solana:0xs", "solana", { tierKey: "single-chain-or-native", protocolLabel: null }),
    route("plume:0xp", "plume"),
  ]);
  const roles = rolesOf([
    component("bridge:unverified", "bridge", 45, "limiting", {
      label: "Unverified bridge controls",
      posture: "opaque-or-unknown",
      tone: "warn",
    }),
    component("mint", "mint", 80, "eligible"),
  ], 45);
  return { summary, roles };
}

describe("BridgingDeploymentsModule", () => {
  it("outlines only routes whose bridge component is the limiting input", () => {
    const arbitrum = route("arbitrum:0xa", "arbitrum", { tierKey: "external-lock-mint" });
    const base = route("base:0xb", "base", { tierKey: "issuer-native-lock-mint" });
    const optimism = route("optimism:0xo", "optimism", { tierKey: "external-lock-mint" });
    const summary = summaryOf([NATIVE, arbitrum, base, optimism]);
    const roles = rolesOf([
      component(bridgeKey(arbitrum), "bridge", 40, "limiting", { posture: "external-lock-mint" }),
      component(bridgeKey(base), "bridge", 60, "eligible", { posture: "issuer-native-lock-mint" }),
      component(bridgeKey(optimism), "bridge", 40, "diagnostic", { posture: "external-lock-mint" }),
      component("mint", "mint", 70, "eligible"),
    ], 40);

    const { container } = render(
      <BridgingDeploymentsModule summary={summary} failureDomains={null} controlRoles={roles} variant="tile" />,
    );

    const outlined = [...container.querySelectorAll("[data-outlined]")].map((cell) => cell.getAttribute("data-cell"));
    expect(outlined).toEqual([arbitrum.key]);
    expect(container.querySelector("[data-band-outlined]")).toBeNull();
    expect(container.querySelector(`[data-cell="${optimism.key}"]`)?.getAttribute("data-role")).toBe("diagnostic");
    expect(container.querySelector(`[data-cell="${NATIVE.key}"]`)?.hasAttribute("data-role")).toBe(false);
    // The verdict names the limiting route.
    expect(buildBridgingDeploymentsVerdict(summary, null, roles)).toMatch(/Arbitrum/);
  });

  it("gives USDe-shaped diagnostic routes a neutral mix chip, never an alarm tone", () => {
    const { summary, roles } = usdeShape();

    const { container } = render(
      <BridgingDeploymentsModule summary={summary} failureDomains={null} controlRoles={roles} variant="tile" />,
    );

    expect(container.querySelectorAll("[data-cell]")).toHaveLength(32);
    expect(container.querySelector("[data-outlined]")).toBeNull();
    expect(container.querySelectorAll('[data-role="diagnostic"]')).toHaveLength(31);

    const chip = buildBridgingDeploymentsIndexChip(summary, null, roles)!;
    expect(chip.toneClass).toBe(SEVERITY_TONE_CLASS.neutral.pill);
    expect(chip.label).toMatch(/mostly/i);
    expect(chip.label.length).toBeLessThanOrEqual(18);
    // The header carries neither role: the strip legend alone keys the diagnostic one.
    const section = container.querySelector("section#bridging")!;
    expect(section.textContent).toContain(chip.label);
    expect(section.textContent).not.toContain(CONTROL_COMPONENT_ROLE_LABELS.limiting);
    const diagnosticTags = [...section.querySelectorAll('[data-control-role="diagnostic"]')];
    expect(diagnosticTags.length).toBeGreaterThan(0);
    expect(diagnosticTags.every((tag) => tag.closest('[role="group"]') !== null)).toBe(true);
  });

  it("puts the score and the limiting tag in the header when a bridge component limits Control", () => {
    const { summary, roles } = ustbShape();

    const { container } = render(
      <BridgingDeploymentsModule summary={summary} failureDomains={null} controlRoles={roles} variant="tile" />,
    );
    const section = container.querySelector("section#bridging")!;
    expect(section.textContent).toContain(CONTROL_COMPONENT_ROLE_LABELS.limiting);
    expect(section.textContent).toMatch(/\b45\b/);

    const verdict = buildBridgingDeploymentsVerdict(summary, null, roles)!;
    expect(verdict).toMatch(/unverified bridge controls/i);
    expect(verdict).toMatch(/\b45\b/);
    expect(findSummaryBudgetViolations(verdict)).toEqual([]);

    const chip = buildBridgingDeploymentsIndexChip(summary, null, roles)!;
    expect(chip.toneClass).not.toBe(SEVERITY_TONE_CLASS.ok.pill);
    expect(chip.label).toMatch(/unverified/i);
  });

  it("outlines the whole strip when the limiting bridge controls map to no route (USTB shape)", () => {
    const { summary, roles } = ustbShape();

    const { container } = render(
      <BridgingDeploymentsModule summary={summary} failureDomains={null} controlRoles={roles} variant="tile" />,
    );

    // Every cell is a reviewed native or burn & mint route, yet the strip may not read as safe.
    expect(container.querySelector("[data-band-outlined]")).not.toBeNull();
    expect(container.querySelector("[data-outlined]")).toBeNull();
    expect(container.querySelector('[data-legend-role="limiting"]')?.textContent).toMatch(/unverified/i);
  });

  it("names an undrawn limiting route on the caveat line instead of outlining the drawn ones", () => {
    const drawn = [NATIVE, route("base:0xb", "base"), route("arbitrum:0xa", "arbitrum", { tierKey: "external-lock-mint" })];
    const summary = summaryOf(drawn, {
      routeCount: 51,
      routesTruncated: 48,
      chainCount: 40,
      tierCounts: { "single-chain-or-native": 1, "issuer-native-burn-mint": 30, "external-lock-mint": 20 },
    });
    const roles = rolesOf([
      component("bridge:tron:0xt:bridge-meta:tron", "bridge", 30, "limiting", { posture: "external-lock-mint" }),
    ], 30);

    const { container } = render(
      <BridgingDeploymentsModule summary={summary} failureDomains={null} controlRoles={roles} variant="tile" />,
    );

    expect(container.querySelector("[data-band-outlined]")).toBeNull();
    expect(container.querySelector("[data-outlined]")).toBeNull();
    expect(container.querySelector("[data-strip-caveats]")?.textContent).toMatch(/limiting route/i);
  });

  it("leads with the majority instead of one unresolved route (USDC shape)", () => {
    const routes = [
      NATIVE,
      ...Array.from({ length: 6 }, (_, index) => route(`burn${index}:0x${index}`, `burn${index}`)),
      route("arbitrum:0xa", "arbitrum", { tierKey: "canonical-rollup-bridge" }),
      route("corn:0xc", "corn", { tierKey: "opaque-or-unknown", reviewed: false }),
    ];
    const summary = summaryOf(routes);

    const chip = buildBridgingDeploymentsIndexChip(summary, null, null)!;
    expect(chip.toneClass).toBe(SEVERITY_TONE_CLASS.neutral.pill);
    expect(chip.label).not.toMatch(/opaque/i);
    expect(chip.label).toMatch(/burn & mint/i);

    const { container } = render(<BridgingDeploymentsModule summary={summary} failureDomains={null} variant="tile" />);
    expect(container.querySelector("section#bridging")?.textContent).toMatch(/1 unresolved/);
    const verdict = buildBridgingDeploymentsVerdict(summary, null)!;
    expect(verdict).toMatch(/mostly issuer burn & mint/i);
    expect(verdict).not.toMatch(/opaque/i);
  });

  it("moves the tier count of a mixed inventory into the verdict and keeps the header and index chip identical", () => {
    const routes = [
      NATIVE,
      route("burn0:0x0", "burn0"),
      route("burn1:0x1", "burn1"),
      route("lz0:0x0", "lz0", { tierKey: "external-lock-mint" }),
      route("lz1:0x1", "lz1", { tierKey: "external-lock-mint" }),
      route("axelar:0xa", "axelar", { tierKey: "external-validated-network" }),
      route("corn:0xc", "corn", { tierKey: "opaque-or-unknown", reviewed: false }),
    ];
    const summary = summaryOf(routes);

    const chip = buildBridgingDeploymentsIndexChip(summary, null, null)!;
    expect(chip.label).not.toMatch(/tiers?\b/);
    expect(chip.label).toMatch(/\b1 unresolved\b/);
    expect(buildBridgingDeploymentsVerdict(summary, null)).toMatch(/\b4 tiers\b/);

    const { container } = render(<BridgingDeploymentsModule summary={summary} failureDomains={null} variant="tile" />);
    const badges = [...container.querySelectorAll('section#bridging [data-slot="badge"]')].map((badge) => badge.textContent);
    expect(badges).toContain(chip.label);
  });

  it("keeps every route-mix chip short enough for a tile header, whatever tier leads", () => {
    // ~160 px at 11 px: what a 480 px tile header leaves beside the coin and title.
    const HEADER_CHIP_MAX_CHARS = 25;
    for (const tier of BRIDGE_TIER_POLICY_ORDER) {
      const lead = Array.from({ length: 4 }, (_, index) => route(`${tier}${index}:0x${index}`, `${tier}${index}`, { tierKey: tier }));
      const other = tier === "external-lock-mint" ? "issuer-native-burn-mint" : "external-lock-mint";
      const inventories = [
        summaryOf(lead),
        summaryOf([...lead, route("other:0xo", "other", { tierKey: other }), route("corn:0xc", "corn", { reviewed: false })]),
      ];
      for (const summary of inventories) {
        const label = buildBridgingDeploymentsIndexChip(summary, null, null)!.label;
        expect(label.length, label).toBeLessThanOrEqual(HEADER_CHIP_MAX_CHARS);
      }
    }
  });

  it("keeps the chip with the drawn cells and states a disagreeing authored tier in the notes fold (MAI shape)", () => {
    const routes = Array.from({ length: 15 }, (_, index) => route(`chain${index}:0x${index}`, `chain${index}`));
    const summary = summaryOf(routes, { authoredTier: "external-lock-mint" });

    const chip = buildBridgingDeploymentsIndexChip(summary, null, null)!;
    expect(chip.label).toMatch(/burn & mint/i);
    expect(chip.label).not.toMatch(/lock/i);

    const { getByText } = render(<BridgingDeploymentsModule summary={summary} failureDomains={null} variant="tile" />);
    const note = getByText(/external lock & mint overall/i);
    expect(note.closest("details")).not.toBeNull();
  });

  it("counts third-party routes from the same tiers the legend draws (EURC shape)", () => {
    const natives = ["ethereum", "base", "avalanche", "stellar", "solana", "arc", "plasma", "cronos", "worldchain"]
      .map((chain) => route(`${chain}:0x`, chain, { tierKey: "single-chain-or-native", protocolLabel: null }));
    const representations = [
      route("polygon:0x", "polygon", { tierKey: "external-validated-network" }),
      route("sonic:0x", "sonic", { tierKey: "external-validated-network" }),
      route("cardano:0x", "cardano", { tierKey: "external-validated-network" }),
      route("tempo:0x", "tempo", { tierKey: "external-lock-mint" }),
    ];
    const summary = summaryOf([...natives, ...representations], { authoredTier: "single-chain-or-native" });

    const { container } = render(<BridgingDeploymentsModule summary={summary} failureDomains={null} variant="tile" />);
    const legend = [...container.querySelectorAll("[data-legend-entry]")];
    const thirdPartyDrawn = legend
      .filter((entry) => /external/i.test(entry.textContent ?? ""))
      .reduce((sum, entry) => sum + Number(entry.querySelector("[data-legend-count]")?.textContent), 0);

    expect(thirdPartyDrawn).toBe(4);
    expect(buildBridgingDeploymentsVerdict(summary, null)).toMatch(/\b4 third-party\b/);
    // A multi-chain asset's native tier reads "Native", never "Single-chain".
    expect(legend[0]?.textContent).toMatch(/^Native/);
    expect(container.textContent).not.toMatch(/single-chain/i);
  });

  it("says all routes are native when nothing is weaker", () => {
    const summary = summaryOf([
      NATIVE,
      route("solana:0xs", "solana", { tierKey: "single-chain-or-native", protocolLabel: null }),
    ]);
    expect(buildBridgingDeploymentsIndexChip(summary, null, null)?.label).toBe("All routes native");
    expect(buildBridgingDeploymentsVerdict(summary, null)).not.toMatch(/weakest|third-party/i);
  });

  it("brackets the cells a failure domain spans, with 'share unquantified' and never '?'", () => {
    const plasma = route("plasma:0xp", "plasma", { tierKey: "external-lock-mint", protocolKey: "layerzero-v2" });
    const solana = route("solana:0xs", "solana", { tierKey: "external-lock-mint", protocolKey: "layerzero-v2" });
    const summary = summaryOf([NATIVE, plasma, solana]);
    const failureDomains: FailureDomainsView = {
      rows: [
        domainRow({ key: "chain:Plasma", label: "Plasma", kind: "chain", exposureShare: 0.108, resolved: true, span: { chainIds: ["plasma"], routeKeys: [], protocolKeys: [] } }),
        domainRow({ key: "bridge:LayerZero V2", label: "LayerZero V2", memberCount: 3, span: { chainIds: [], routeKeys: [], protocolKeys: ["layerzero-v2"] } }),
      ],
      totalAdjustmentPoints: 0,
    };

    const { container } = render(
      <BridgingDeploymentsModule summary={summary} failureDomains={failureDomains} variant="tile" />,
    );

    const unquantified = container.querySelector('[data-bracket="bridge:LayerZero V2"]');
    expect(unquantified?.querySelector("[data-bracket-share]")?.textContent).toBe("share unquantified");
    expect(unquantified?.textContent).toContain("×3");
    const quantified = container.querySelector('[data-bracket="chain:Plasma"] [data-bracket-share]')?.textContent;
    expect(quantified).toMatch(/%$/);
    expect(container.querySelector("section#bridging")?.textContent).not.toContain("?");
  });

  it("puts the #failure-domains anchor on the fold itself, so the section scroll margin applies to it", () => {
    const plasma = route("plasma:0xp", "plasma", { tierKey: "external-lock-mint" });
    const failureDomains: FailureDomainsView = {
      rows: [domainRow({ key: "chain:Plasma", label: "Plasma", span: { chainIds: ["plasma"], routeKeys: [], protocolKeys: [] } })],
      totalAdjustmentPoints: 0,
    };

    const { container } = render(
      <BridgingDeploymentsModule summary={summaryOf([NATIVE, plasma])} failureDomains={failureDomains} variant="tile" />,
    );

    expect(container.querySelector("section#bridging details#failure-domains")).not.toBeNull();
  });

  it("renders a single-chain coin in strip form without a one-cell strip", () => {
    const summary = summaryOf([NATIVE]);

    const { container } = render(
      <BridgingDeploymentsModule summary={summary} failureDomains={null} variant="tile" />,
    );

    expect(resolveBridgingDeploymentsForm(summary, null)).toBe("strip");
    expect(container.querySelector("section#bridging")?.getAttribute("data-evidence-module")).toBe("strip");
    expect(container.querySelector("[data-cell]")).toBeNull();
    expect(container.textContent).toContain(BRIDGE_TIER_LABELS["single-chain-or-native"]);
  });

  it("counts every route in a truncated strip's legend and says how many are drawn", () => {
    const drawn = [NATIVE, route("base:0xb", "base"), route("arbitrum:0xa", "arbitrum", { tierKey: "external-lock-mint" })];
    const truncatedSummary = summaryOf(drawn, {
      routeCount: 51,
      routesTruncated: 48,
      chainCount: 40,
      tierCounts: { "single-chain-or-native": 1, "issuer-native-burn-mint": 30, "external-lock-mint": 20 },
    });

    const truncated = render(
      <BridgingDeploymentsModule summary={truncatedSummary} failureDomains={null} variant="tile" />,
    );
    expect(legendCounts(truncated.container).reduce((sum, count) => sum + count, 0)).toBe(51);
    const caveats = truncated.container.querySelectorAll("[data-strip-caveats]");
    expect(caveats).toHaveLength(1);
    expect(caveats[0]?.textContent).toContain("3 of 51");
    truncated.unmount();

    const complete = render(<BridgingDeploymentsModule summary={summaryOf(drawn)} failureDomains={null} variant="tile" />);
    expect(legendCounts(complete.container)).toEqual([1, 1, 1]);
    expect(complete.container.querySelector("[data-strip-caveats]")?.textContent).not.toMatch(/drawn/);
  });

  it("keeps the authored summary and sources in one closed fold after the domain detail", () => {
    const plasma = route("plasma:0xp", "plasma", { tierKey: "external-lock-mint" });
    const summary = summaryOf([NATIVE, plasma]);
    const failureDomains: FailureDomainsView = {
      rows: [domainRow({ key: "chain:Plasma", label: "Plasma", span: { chainIds: ["plasma"], routeKeys: [], protocolKeys: [] } })],
      totalAdjustmentPoints: 0,
    };
    const roles = rolesOf([component(bridgeKey(plasma), "bridge", 45, "limiting", { posture: "external-lock-mint" })], 45);

    const { container, getByText } = render(
      <BridgingDeploymentsModule summary={summary} failureDomains={failureDomains} controlRoles={roles} variant="tile" />,
    );

    const notesFold = getByText(AUTHORED_SUMMARY).closest("details");
    expect(notesFold).not.toBeNull();
    expect(notesFold?.open).toBe(false);
    expect(notesFold?.querySelector('a[href="https://example.com/bridge"]')).not.toBeNull();

    // Fixed order: scoring breakdown → domain detail → review notes & sources.
    const folds = [...container.querySelectorAll("details")];
    const scoringIndex = folds.findIndex((fold) => fold.querySelector('[aria-label="Bridge components by role"]'));
    const domainIndex = folds.findIndex((fold) => fold.id === "failure-domains");
    expect(scoringIndex).toBeGreaterThanOrEqual(0);
    expect(scoringIndex).toBeLessThan(domainIndex);
    expect(domainIndex).toBeLessThan(folds.indexOf(notesFold!));
  });

  it("renders failure domains without a bridge review, and nothing without either", () => {
    const failureDomains: FailureDomainsView = {
      rows: [domainRow({ key: "chain:Solana", label: "Solana", kind: "chain" })],
      totalAdjustmentPoints: 0,
    };

    const { container } = render(
      <BridgingDeploymentsModule summary={null} failureDomains={failureDomains} variant="tile" />,
    );
    expect(container.querySelector("section#bridging #failure-domains")).not.toBeNull();
    expect(container.querySelector("section#bridging")?.getAttribute("data-evidence-module")).toBe("strip");
    expect(buildBridgingDeploymentsIndexChip(null, failureDomains, null)?.toneClass).toBe(SEVERITY_TONE_CLASS.neutral.pill);

    const empty = render(
      <BridgingDeploymentsModule summary={null} failureDomains={{ rows: [], totalAdjustmentPoints: 0 }} variant="tile" />,
    );
    expect(empty.container.innerHTML).toBe("");
    expect(buildBridgingDeploymentsIndexChip(null, null, null)).toBeNull();
  });
});

describe("buildBridgingDeploymentsVerdict", () => {
  it("stays within the verdict budget for the largest inventories and states unresolved routes", () => {
    const routes = Array.from({ length: 40 }, (_, index) =>
      route(`chain${index}:0x${index}`, `chain${index}`, {
        tierKey: index < 2 ? "opaque-or-unknown" : index % 4 === 0 ? "external-lock-mint" : "external-validated-network",
        reviewed: index >= 2,
      }),
    );
    const summary = summaryOf(routes, {
      routeCount: 88,
      chainCount: 31,
      thirdPartyRouteCount: 22,
      unresolvedRouteCount: 2,
      routesTruncated: 48,
    });

    const verdict = buildBridgingDeploymentsVerdict(summary, null, usdeShape().roles)!;
    expect(findSummaryBudgetViolations(verdict)).toEqual([]);
    expect(verdict).toContain("88");
    expect(verdict).toContain("31");
    expect(verdict).toContain("25%");
    expect(verdict).toMatch(/\b2 unresolved\b/);

    const resolved = buildBridgingDeploymentsVerdict({ ...summary, unresolvedRouteCount: 0 }, null)!;
    expect(resolved).not.toMatch(/unresolved/);
  });

  it("keeps the limiting clause within budget on a mixed inventory", () => {
    const { roles } = ustbShape();
    const routes = [
      NATIVE,
      ...Array.from({ length: 5 }, (_, index) => route(`burn${index}:0x${index}`, `burn${index}`)),
      ...Array.from({ length: 4 }, (_, index) => route(`lz${index}:0x${index}`, `lz${index}`, { tierKey: "external-lock-mint" })),
      route("corn:0xc", "corn", { tierKey: "opaque-or-unknown", reviewed: false }),
    ];
    const verdict = buildBridgingDeploymentsVerdict(summaryOf(routes), null, roles)!;
    expect(findSummaryBudgetViolations(verdict)).toEqual([]);
    expect(verdict).toMatch(/unverified bridge controls/i);
  });
});
