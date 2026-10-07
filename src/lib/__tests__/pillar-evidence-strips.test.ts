import { describe, expect, it } from "vitest";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { BRIDGE_TIER_LABELS } from "@shared/lib/classification";
import { makeV9Card, makeV9Pillars } from "@/test/fixtures/safety-score-v9";
import { resolveMintAuthorityScoreDisplay } from "@/lib/mint-authority-display";
import { resolveControlComponentRoles } from "@/lib/pillar-evidence-strips";

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

  it("names the native-issuance bridge component after the Bridging module, in its single-chain wording", () => {
    const native = { ...component("bridge:native", "bridge", 95, true), posture: "single-chain-or-native" };
    const card = cardWithControl([native, component("mint", "mint", 70, true)], { evaluated: 70, published: 70 });

    const row = resolveControlComponentRoles(card)!.components.find((entry) => entry.key === "bridge:native")!;
    expect(row.label).not.toBe(native.label);
    expect(row.postureLabel).toBe(BRIDGE_TIER_LABELS["single-chain-or-native"]);
  });

  it("reads bridge postures in the tile's tier vocabulary", () => {
    const roles = resolveControlComponentRoles(cardWithControl([component("bridge:base", "bridge", 45, true)]))!;
    expect(roles.components[0]!.postureLabel).toBe(BRIDGE_TIER_LABELS["external-lock-mint"]);
  });
});
