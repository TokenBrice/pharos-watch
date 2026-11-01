export function isUnknownSafetyScoreV9Value(value: string): boolean {
  return value.trim().toLowerCase() === "unknown";
}

export function humanizeSafetyScoreV9Value(value: string): string {
  const explicitLabels: Record<string, string> = {
    "none-known": "None known",
    "eligibility-gated": "Eligibility gated",
    "issuer-discretionary": "Issuer discretionary",
    "single-entity": "Single entity",
    // No credited route on an incomplete or unintegrated exit surface.
    // This is not a finding that the issuer failed to disclose its policy.
    undisclosed: "Incomplete exit surface",
  };
  const explicit = explicitLabels[value];
  if (explicit) return explicit;
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[-\s]+/u)
    .filter(Boolean)
    .map((part, index) => {
      if (index === 0) return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
      // A camelCase hump becomes a sentence-case word; acronyms keep their case.
      return /^[A-Z][a-z]+$/u.test(part) ? part.toLowerCase() : part;
    })
    .join(" ");
}

/**
 * Factor keys carry their producer path (`reserve:<exposureKey>:assetClass`,
 * `mechanism:<componentKey>:factor:<factKey>`) and a covered/uncovered split.
 * Only the fact itself belongs in the reader-facing label.
 */
export function humanizeSafetyScoreV9FactorLabel(componentKey: string): string {
  const mechanism = componentKey.match(/^mechanism:.+:factor:([^:]+)$/u);
  if (mechanism) return humanizeSafetyScoreV9Value(mechanism[1]);
  const splitSuffix = componentKey.match(/^(.+):(covered|uncovered)$/u);
  const baseKey = splitSuffix ? splitSuffix[1] : componentKey;
  const reserve = baseKey.match(/^reserve:.+:([^:]+)$/u);
  if (reserve) {
    const label = humanizeSafetyScoreV9Value(reserve[1]);
    return splitSuffix ? `${label} (${splitSuffix[2]})` : label;
  }
  return humanizeSafetyScoreV9Value(componentKey);
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
