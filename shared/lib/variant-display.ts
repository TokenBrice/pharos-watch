import type { VariantKind } from "../types";

const VARIANT_DISPLAY: Record<
  VariantKind,
  {
    shortLabel: string;
    fullLabel: string;
    badgeClass: string;
    chipClass: string;
  }
> = {
  "pure-wrapper": {
    shortLabel: "Wrapped",
    fullLabel: "Pure wrapper variant",
    badgeClass: "border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    chipClass: "border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  },
  "savings-passthrough": {
    shortLabel: "Savings",
    fullLabel: "Savings variant",
    badgeClass: "border-frost-blue/30 bg-frost-blue/10 text-frost-blue",
    chipClass: "border-frost-blue/30 bg-frost-blue/10 text-frost-blue",
  },
  "strategy-vault": {
    shortLabel: "Strategy",
    fullLabel: "Strategy vault variant",
    badgeClass: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
    chipClass: "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-400",
  },
  "risk-absorption": {
    shortLabel: "Risk-Abs",
    fullLabel: "Risk absorption variant",
    badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    chipClass: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  },
  "bond-maturity": {
    shortLabel: "Bond",
    fullLabel: "Bond variant",
    badgeClass: "border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300",
    chipClass: "border-slate-500/25 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  },
};

export function getVariantDisplay(kind: VariantKind) {
  return VARIANT_DISPLAY[kind];
}

export function getVariantAccessibleLabel(kind: VariantKind): string {
  return VARIANT_DISPLAY[kind].fullLabel;
}
