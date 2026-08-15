import { resolveMechanismArchetype } from "@shared/lib/classification/resolve-mechanism-archetype";
import type { StablecoinMeta } from "@shared/types";

export type MechanismArchetypeCoverageFindingKind =
  "missing-classification" | "missing-unresolved-review" | "invalid-override-review";

export interface MechanismArchetypeCoverageFinding {
  id: string;
  kind: MechanismArchetypeCoverageFindingKind;
  detail: string;
}

export interface MechanismArchetypeCoverageResult {
  active: number;
  direct: number;
  inherited: number;
  reviewedUnresolved: number;
  resolved: number;
  findings: MechanismArchetypeCoverageFinding[];
}

export function analyzeMechanismArchetypeCoverage(coins: readonly StablecoinMeta[]): MechanismArchetypeCoverageResult {
  const active = coins.filter((coin) => (coin.status ?? "active") === "active");
  const registry = new Map(active.map((coin) => [coin.id, coin] as const));
  const findings: MechanismArchetypeCoverageFinding[] = [];
  let direct = 0;
  let inherited = 0;
  let reviewedUnresolved = 0;

  for (const coin of active) {
    const resolved = resolveMechanismArchetype(coin, registry);
    if (resolved) {
      if (coin.mechanismArchetype) direct += 1;
      else inherited += 1;
    } else if (coin.mechanismArchetypeReview?.disposition === "unresolved" && !coin.variantOf) {
      reviewedUnresolved += 1;
    } else {
      findings.push({
        id: coin.id,
        kind: coin.mechanismArchetypeReview ? "missing-classification" : "missing-unresolved-review",
        detail: coin.variantOf
          ? `variant cannot resolve an archetype from parent ${coin.variantOf}`
          : "active asset has neither a resolved archetype nor a reviewed unresolved disposition",
      });
    }

    if (coin.archetypeOverride === true && coin.mechanismArchetypeReview?.disposition !== "resolved") {
      findings.push({
        id: coin.id,
        kind: "invalid-override-review",
        detail: "intentional archetype override lacks a resolved review",
      });
    }
  }

  findings.sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind));
  return {
    active: active.length,
    direct,
    inherited,
    reviewedUnresolved,
    resolved: direct + inherited,
    findings,
  };
}
