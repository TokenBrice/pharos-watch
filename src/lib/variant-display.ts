import type { VariantKind } from "@shared/types";

const VARIANT_DISPLAY: Record<
  VariantKind,
  {
    shortLabel: string;
    fullLabel: string;
    badgeClass: string;
    chipClass: string;
  }
> = {
  "savings-passthrough": {
    shortLabel: "Savings",
    fullLabel: "Savings variant",
    badgeClass: "border-frost-blue/30 bg-frost-blue/10 text-frost-blue",
    chipClass: "border-frost-blue/30 bg-frost-blue/10 text-frost-blue",
  },
  "risk-absorption": {
    shortLabel: "Risk-Abs",
    fullLabel: "Risk absorption variant",
    badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    chipClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
};

export function getVariantDisplay(kind: VariantKind) {
  return VARIANT_DISPLAY[kind];
}

export function getVariantAccessibleLabel(kind: VariantKind): string {
  return VARIANT_DISPLAY[kind].fullLabel;
}
