import type { SafetyScoreV9CurrentCard } from "@shared/types";

export function isUnknownSafetyScoreV9Value(value: string): boolean {
  return value.trim().toLowerCase() === "unknown";
}

export function humanizeSafetyScoreV9Value(value: string): string {
  const explicitLabels: Record<string, string> = {
    "none-known": "None known",
    "eligibility-gated": "Eligibility gated",
    "issuer-discretionary": "Issuer discretionary",
    "single-entity": "Single entity",
    // An undisclosed primary exit is an absence of evidence, not a reviewed
    // absence of an exit. It keeps its row (only "unknown" drops out) and reads
    // as a gap rather than as the "None" assertion it used to publish.
    undisclosed: "Not disclosed",
  };
  const explicit = explicitLabels[value];
  if (explicit) return explicit;
  return value
    .split("-")
    .filter(Boolean)
    .map((part, index) => index === 0 ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

export function buildSafetyScoreV9TraceParts(card: SafetyScoreV9CurrentCard): string[] {
  const { stages } = card.scoreTrace;
  if (stages.preCapScore === null) return [];

  const parts = [`Pre-cap ${stages.preCapScore.toFixed(1)}`];
  if (card.bindingCap) {
    const capLabel = card.bindingCap.kind.startsWith("track-record")
      ? "Track-record"
      : card.bindingCap.source === "active-depeg"
        ? "Active-depeg"
        : humanizeSafetyScoreV9Value(card.bindingCap.source);
    parts.push(`${capLabel} cap ${card.bindingCap.limit.toFixed(0)}`);
  }
  if (stages.pegMultiplier !== null && Math.abs(stages.pegMultiplier - 1) >= 0.005) {
    parts.push(`Peg x${stages.pegMultiplier.toFixed(3)}`);
  }
  if (stages.deploymentAdjustmentPoints !== null && stages.deploymentAdjustmentPoints >= 0.05) {
    parts.push(`Deployment -${stages.deploymentAdjustmentPoints.toFixed(1)}`);
  }
  if (card.scoreTrace.wrapperParentLimit) {
    parts.push(`Parent limit ${card.scoreTrace.wrapperParentLimit.limit.toFixed(0)}`);
  }
  return parts;
}

/** Round long measured fractions for display and preserve first occurrence order. */
export function uniqueSafetyScoreV9Messages(messages: readonly string[]): string[] {
  return [...new Set(messages
    .map((message) => message.trim().replace(/\d+\.\d{4,}/g, (value) => Number(value).toFixed(3)))
    .filter(Boolean))];
}

export interface StablecoinSafetyScoreV9Component {
  key: string;
  label: string;
  category: string;
}

function componentBaseLabel(component: string): { label: string; category: string } {
  if (component === "mint") return { label: "Mint authority", category: "Authority" };
  if (component === "oracle") return { label: "Oracle design", category: "Oracle" };
  if (component.startsWith("mechanism:")) {
    return {
      label: humanizeSafetyScoreV9Value(component.slice("mechanism:".length)),
      category: "Mechanism",
    };
  }
  if (component === "reserve:concentration") {
    return { label: "Reserve concentration", category: "Reserve" };
  }
  if (component.startsWith("reserve:reserve:")) {
    return { label: "Reserve slice", category: "Reserve" };
  }
  if (component.startsWith("redemption:")) {
    const routeKind = component.split(":").at(-1) ?? "route";
    return {
      label: routeKind === "collateral-redeem"
        ? "Collateral redemption"
        : humanizeSafetyScoreV9Value(routeKind),
      category: "Redemption",
    };
  }
  if (component.startsWith("bridge:")) {
    const chain = component.split(":")[1] ?? "deployment";
    return {
      label: `${humanizeSafetyScoreV9Value(chain)} bridge`,
      category: "Bridge",
    };
  }
  if (component.startsWith("dex:")) {
    let decoded = component;
    try {
      decoded = decodeURIComponent(component);
    } catch {
      // The public key remains usable even if a producer emits malformed escaping.
    }
    const venue = decoded.includes(":curve:") ? "Curve" : "DEX";
    return { label: `${venue} liquidity route`, category: "DEX" };
  }
  return {
    label: humanizeSafetyScoreV9Value(component.replaceAll(":", " ")),
    category: "Input",
  };
}

export function describeSafetyScoreV9Components(
  components: readonly string[],
): StablecoinSafetyScoreV9Component[] {
  const base = components.map((component) => ({ key: component, ...componentBaseLabel(component) }));
  const totals = new Map<string, number>();
  for (const item of base) {
    const groupingKey = `${item.category}\u0000${item.label}`;
    totals.set(groupingKey, (totals.get(groupingKey) ?? 0) + 1);
  }
  const occurrences = new Map<string, number>();
  return base.map((item) => {
    const groupingKey = `${item.category}\u0000${item.label}`;
    const occurrence = (occurrences.get(groupingKey) ?? 0) + 1;
    occurrences.set(groupingKey, occurrence);
    return {
      ...item,
      label: (totals.get(groupingKey) ?? 0) > 1 ? `${item.label} ${occurrence}` : item.label,
    };
  });
}
