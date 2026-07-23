import type { VariantKind } from "../types";

const LEGACY_WRAPPER_PENALTY = 3;

const VARIANT_WRAPPER_PENALTY: Record<VariantKind, number> = {
  "pure-wrapper": 3,
  "savings-passthrough": 3,
  "strategy-vault": 5,
  "risk-absorption": 5,
  "bond-maturity": 8,
};

export function wrapperPenaltyForVariant(variantKind?: VariantKind | null): number {
  return variantKind ? VARIANT_WRAPPER_PENALTY[variantKind] : LEGACY_WRAPPER_PENALTY;
}
