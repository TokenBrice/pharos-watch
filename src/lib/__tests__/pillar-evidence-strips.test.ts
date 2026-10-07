import { describe, expect, it } from "vitest";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { BRIDGE_TIER_LABELS } from "@shared/lib/classification";
import { makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { resolveMintAuthorityScoreDisplay } from "@/lib/mint-authority-display";
import { buildPillarEvidenceStrips, resolveControlComponentRoles } from "@/lib/pillar-evidence-strips";

type ControlComponent = NonNullable<SafetyScoreV9CurrentCard["breakdowns"]>["control"]["components"][number];

function component(
  key: string,
  kind: ControlComponent["kind"],
  score: number | null,
  binding: boolean,
): ControlComponent {
  return {
    key, label: `${key} label`, kind, score, binding, posture: "external-lock-mint",
    cause: null, causeGapRefs: [], scoringDisposition: "included", effectiveScoringWeight: score === null ? 0 : 1,
  } as ControlComponent;
}

function cardWithControl(
  components: ControlComponent[],
  scores: { evaluated: number | null; published: number | null } = { evaluated: 45, published: 45 },
): SafetyScoreV9CurrentCard {
  const card = makeV9Card({ pillars: makeV9Pillars({ backing: 76, exit: 85, control: scores.published }) });
  const control = card.breakdowns!.control;
  control.components = components;
  control.evaluatedScore = scores.evaluated;
  control.publishedScore = scores.published;
  return card;
}

const USDE_BRIDGES = Array.from({ length: 31 }, (_, index) =>
  component(`bridge:chain-${String(index).padStart(2, "0")}`, "bridge", 45, false));

function rolesByKey(card: SafetyScoreV9CurrentCard) {
  return Object.fromEntries(resolveControlComponentRoles(card)!.components.map((row) => [row.key, row.role]));
}

describe("resolveControlComponentRoles", () => {
  it("limits only on eligible components at the minimum; non-binding peers at the same score stay diagnostic", () => {
    const card = cardWithControl([
      ...USDE_BRIDGES,
      component("mint", "mint", 68, true),
      component("oracle", "oracle", 45, true),
    ]);
    const roles = resolveControlComponentRoles(card)!;
    expect(roles.minimum).toBe(45);
    const byKey = rolesByKey(card);
    expect(byKey.oracle).toBe("limiting");
    expect(byKey.mint).toBe("eligible");
    expect(USDE_BRIDGES.every((bridge) => byKey[bridge.key] === "diagnostic")).toBe(true);
    expect(roles.components.filter((row) => row.role === "limiting")).toHaveLength(1);
  });

  it("marks every eligible component tied at the minimum as limiting", () => {
    const byKey = rolesByKey(cardWithControl([
      component("mint", "mint", 70, true),
      component("oracle", "oracle", 70, true),
      component("bridge:a", "bridge", 90, true),
    ], { evaluated: 70, published: 70 }));
    expect(byKey).toMatchObject({ mint: "limiting", oracle: "limiting", "bridge:a": "eligible" });
  });

  it("has no limiting component when the eligible set is empty", () => {
    const roles = resolveControlComponentRoles(cardWithControl([
      component("bridge:a", "bridge", 30, false),
    ], { evaluated: 50, published: 50 }))!;
    expect(roles.minimum).toBeNull();
    expect(roles.components.some((row) => row.role === "limiting")).toBe(false);
    expect(roles.adjusted).toBe(false);
  });

  it("excludes null-scored components, which never set the minimum", () => {
    const card = cardWithControl([
      component("mint", "mint", 60, true),
      component("inventory", "inventory", null, false),
    ], { evaluated: 60, published: 60 });
    expect(rolesByKey(card)).toMatchObject({ mint: "limiting", inventory: "excluded" });
    expect(resolveControlComponentRoles(card)!.minimum).toBe(60);
  });

  it("flags adjustment only when the published score moves off the minimum at display precision", () => {
    const components = [component("mint", "mint", 65, true)];
    expect(resolveControlComponentRoles(cardWithControl(components, { evaluated: 65, published: 64.03 }))!.adjusted).toBe(true);
    expect(resolveControlComponentRoles(cardWithControl(components, { evaluated: 65, published: 64.98 }))!.adjusted).toBe(false);
    expect(resolveControlComponentRoles(cardWithControl(components, { evaluated: 65, published: 65 }))!.adjusted).toBe(false);
  });

  it("returns null without a breakdown", () => {
    expect(resolveControlComponentRoles({ ...makeV9Card(), breakdowns: null })).toBeNull();
  });

  it("tones mint rows by the Mint Authority band, never by the score's grade range", () => {
    const hardened = { ...component("mint", "mint", 55, true), posture: "bounded-admin" };
    const exposed = { ...component("mint:binding", "mint", 90, true), posture: "unbounded-adverse" };
    const roles = resolveControlComponentRoles(cardWithControl([hardened, exposed], { evaluated: 55, published: 55 }))!;
    const byKey = Object.fromEntries(roles.components.map((row) => [row.key, row]));
    // A "Hardened 55" reads as the module pill does (its band), not as a D-range warning.
    expect(resolveMintAuthorityScoreDisplay(hardened).bandKey).toBe("hardened");
    expect(byKey.mint!.tone).toBe("neutral");
    expect(byKey["mint:binding"]!.tone).toBe("critical");
  });

  it("names the native-issuance bridge component from the Bridging tile's route tiers", () => {
    const native = { ...component("bridge:native", "bridge", 95, true), posture: "single-chain-or-native" };
    const card = cardWithControl([native, component("mint", "mint", 70, true)], { evaluated: 70, published: 70 });

    const burnMint = resolveControlComponentRoles(card, { chainCount: 15, tierCounts: { "issuer-native-burn-mint": 15 }, unresolvedRouteCount: 0 })!
      .components.find((row) => row.key === "bridge:native")!;
    expect(burnMint.label).not.toBe(native.label);
    expect(burnMint.postureLabel).toBe(BRIDGE_TIER_LABELS["issuer-native-burn-mint"]);

    // A multi-chain coin never reads "Single-chain", whatever its route tiers.
    const multiChain = [
      { chainCount: 5, tierCounts: {}, unresolvedRouteCount: 0 },
      { chainCount: 5, tierCounts: { "single-chain-or-native": 5 }, unresolvedRouteCount: 0 },
      { chainCount: 5, tierCounts: { "single-chain-or-native": 1, "issuer-native-burn-mint": 4 }, unresolvedRouteCount: 0 },
      { chainCount: 5, tierCounts: { "single-chain-or-native": 2, "issuer-native-burn-mint": 2 }, unresolvedRouteCount: 1 },
    ];
    for (const bridging of multiChain) {
      const row = resolveControlComponentRoles(card, bridging)!.components.find((entry) => entry.key === "bridge:native")!;
      expect(row.postureLabel).not.toBe(BRIDGE_TIER_LABELS["single-chain-or-native"]);
    }

    // Without a route inventory the coin has nothing to bridge: the tile's single-chain wording.
    const unreviewed = resolveControlComponentRoles(card)!.components.find((row) => row.key === "bridge:native")!;
    expect(unreviewed.postureLabel).toBe(BRIDGE_TIER_LABELS["single-chain-or-native"]);
  });

  it("reads bridge postures in the tile's tier vocabulary", () => {
    const roles = resolveControlComponentRoles(cardWithControl([component("bridge:base", "bridge", 45, true)]))!;
    expect(roles.components[0]!.postureLabel).toBe(BRIDGE_TIER_LABELS["external-lock-mint"]);
  });
});

describe("buildPillarEvidenceStrips", () => {
  it("returns no strips for missing or frozen cards", () => {
    expect(buildPillarEvidenceStrips(null)).toEqual({ backing: null, exit: null, control: null });
    expect(buildPillarEvidenceStrips(makeV9Card(), { frozen: true })).toEqual({ backing: null, exit: null, control: null });
  });

  it("aggregates same-role bridges into one row with count and score range, keeping lone components as rows", () => {
    const control = buildPillarEvidenceStrips(cardWithControl([
      ...USDE_BRIDGES,
      component("bridge:zz-high", "bridge", 85, false),
      component("mint", "mint", 68, true),
      component("oracle", "oracle", 45, true),
    ])).control!;
    const groups = control.rows.flatMap((row) => row.type === "group" ? [row.group] : []);
    expect(groups).toEqual([expect.objectContaining({ kind: "bridge", role: "diagnostic", count: 32, minScore: 45, maxScore: 85 })]);
    // The count names what it counts, never the bridging tile's route total.
    expect(groups[0]!.noun).not.toMatch(/route/i);
    const single = control.rows.flatMap((row) => row.type === "component" ? [row.component.key] : []);
    expect(single.sort()).toEqual(["mint", "oracle"]);
    // Eligible rows lead; the limiting input is read first.
    expect(control.rows[0]).toMatchObject({ type: "component", component: { role: "limiting" } });
  });

  it("keeps a lone bridge as its own row in its role", () => {
    const control = buildPillarEvidenceStrips(cardWithControl([
      component("bridge:unverified", "bridge", 45, true),
      component("mint", "mint", 67, true),
    ])).control!;
    expect(control.rows.every((row) => row.type === "component")).toBe(true);
    expect(control.rows[0]).toMatchObject({ component: { key: "bridge:unverified", role: "limiting" } });
  });

  it("groups non-eligible components of one kind and posture, keeps eligible ones individual, and scopes same-kind rows", () => {
    const deploymentMints = Array.from({ length: 57 }, (_, index) =>
      component(`mint:deployment:path-${index}`, "mint", 100, false));
    const control = buildPillarEvidenceStrips(cardWithControl([
      ...deploymentMints,
      component("mint", "mint", 70, true),
      component("oracle", "oracle", 80, true),
      component("oracle:known-paths", "oracle", 85, true),
    ], { evaluated: 70, published: 70 })).control!;
    const groups = control.rows.flatMap((row) => row.type === "group" ? [row.group] : []);
    expect(groups).toEqual([expect.objectContaining({ kind: "mint", role: "diagnostic", count: 57, minScore: 100 })]);
    const singles = control.rows.flatMap((row) => row.type === "component" ? [row] : []);
    expect(singles.map((row) => row.component.key).sort()).toEqual(["mint", "oracle", "oracle:known-paths"]);
    // Two mint rows and two oracle rows: each component row carries a distinct scope.
    const scopes = singles.map((row) => row.scope);
    expect(scopes.every((scope) => scope !== null)).toBe(true);
    expect(new Set(scopes).size).toBe(scopes.length);
  });

  it("leaves a lone component of its kind unscoped", () => {
    const control = buildPillarEvidenceStrips(cardWithControl([component("mint", "mint", 60, true)], { evaluated: 60, published: 60 })).control!;
    expect(control.rows).toEqual([expect.objectContaining({ type: "component", scope: null })]);
  });

  it("states bridged supply priced only as an adjustment as an unscored bridges row", () => {
    const card = cardWithControl([component("mint", "mint", 84, true)], { evaluated: 84, published: 82.38 });
    card.breakdowns!.control.adjustments = [
      { kind: "unresolved-deployment-share", scoreBefore: 84, scoreAfter: 82.38, delta: -1.62 },
    ];
    const control = buildPillarEvidenceStrips(card).control!;
    expect(control.rows.at(-1)).toEqual({ type: "unresolved-bridges", delta: -1.62 });
    expect(control.adjustments).toEqual([expect.objectContaining({ kind: "unresolved-deployment-share", delta: -1.62 })]);

    card.breakdowns!.control.components.push(component("bridge:base", "bridge", 65, false));
    expect(buildPillarEvidenceStrips(card).control!.rows.some((row) => row.type === "unresolved-bridges")).toBe(false);
  });

  it("is null-safe when the exit route or its capacity is absent", () => {
    const card = makeV9Card({ pillars: makeV9Pillars({ backing: 76, exit: 35, control: 45 }) });
    const exit = card.breakdowns!.exit;
    const withoutCapacity = buildPillarEvidenceStrips(card).exit!;
    expect(withoutCapacity.route).not.toBeNull();
    expect(withoutCapacity.capacity).toBeNull();

    exit.primaryRoute!.capacity = {
      executableUsd: 662_433.75, requestedNotionalUsd: 25_000_000, completionRatio: 0.03, maxCostBps: 200,
      executionCostBps: 200, settlementDelaySec: 0, capacityScoringHorizon: "immediate", chain: "ethereum",
      protocol: "uniswap-v4", poolId: null, evidenceKind: "dex-quote", observedAtSec: null,
    } as NonNullable<typeof exit.primaryRoute>["capacity"];
    const measured = buildPillarEvidenceStrips(card).exit!.capacity!;
    expect(measured).toMatchObject({ executableUsd: 662_433.75, requestedNotionalUsd: 25_000_000, maxCostBps: 200 });
    expect(measured.completionRatio).toBeGreaterThan(0);
    expect(measured.completionRatio).toBeLessThan(0.05);
    // A route filling part of the request is a weak, unqualified capacity.
    expect(measured).toMatchObject({ qualified: false });
    expect(measured.tone).not.toBe("neutral");

    exit.primaryRoute!.capacity = { ...exit.primaryRoute!.capacity!, executableUsd: 30_000_000 };
    expect(buildPillarEvidenceStrips(card).exit!.capacity).toMatchObject({ completionRatio: 1, qualified: true, tone: "neutral" });

    // USDe: $25m of $25m at a ratio a hair under 1 is a full fill, never an amber shortfall.
    exit.primaryRoute!.capacity = { ...exit.primaryRoute!.capacity!, executableUsd: 25_000_000 * 0.9995 };
    expect(buildPillarEvidenceStrips(card).exit!.capacity).toMatchObject({ qualified: true, tone: "neutral" });

    // A published insufficient-completion cap is a shortfall whatever the ratio rounds to.
    exit.primaryRoute!.capsApplied = [...exit.primaryRoute!.capsApplied, "insufficient-completion:60"];
    expect(buildPillarEvidenceStrips(card).exit!.capacity).toMatchObject({ qualified: false, tone: "warn" });

    exit.primaryRoute = null;
    exit.alternatives = [{
      key: "redemption:a", label: "Stablecoin redemption", routeFamily: "protocol-redemption", score: null,
      included: false, exclusionReason: "unsupported-same-notional-route", confidenceDimensions: null,
      capacityEvidenceTier: "live-direct", rawSameNotionalCostBps: null, capacity: null,
    }] as typeof exit.alternatives;
    const unrouted = buildPillarEvidenceStrips(card).exit!;
    expect(unrouted.route).toBeNull();
    expect(unrouted.capacity).toBeNull();
    expect(unrouted.excludedRoutes).toEqual([expect.objectContaining({ key: "redemption:a" })]);
    expect(unrouted.stressRequest).not.toBeNull();
  });

  it("projects backing groups and flags bounded mechanism components as unverified", () => {
    const card = makeV9Card({ pillars: makeV9Pillars({ backing: 76, exit: 85, control: 45 }) });
    const backing = card.breakdowns!.backing;
    const base = backing.components[0]!;
    backing.components = [
      { ...base, key: "mechanism:custody", label: "Custody Continuity", source: "mechanism", score: 35, observationState: "bounded-unknown" },
      { ...base, key: "mechanism:nav", label: "Nav Valuation", source: "mechanism", score: 87, observationState: "known" },
      base,
    ];
    const view = buildPillarEvidenceStrips(card).backing!;
    expect(view.grade).not.toBeNull();
    expect(view.groups.map((group) => group.key)).toEqual(backing.groups.map((group) => group.key));
    expect(view.mechanism.map((row) => [row.key, row.state])).toEqual([
      ["mechanism:custody", "unverified"],
      ["mechanism:nav", "known"],
    ]);
  });

  it("never invents a grade for an excluded pillar", () => {
    const card = makeV9Card({ pillars: makeV9Pillars({ backing: 76, exit: 85, control: 45 }) });
    card.pillars.exit = { ...card.pillars.exit, score: null };
    const exit = buildPillarEvidenceStrips(card).exit!;
    expect(exit.score).toBeNull();
    expect(exit.grade).toBeNull();
    expect(exit.excluded).toBe(true);
  });
});
