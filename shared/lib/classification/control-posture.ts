import type { GovernanceQuality } from "../../types";

export interface ControlPostureStyle {
  label: string;
  shortLabel: string;
  stripLabel: string;
  badgeClassName: string;
  activeCellClassName: string;
  iconClassName: string;
}

/**
 * User-facing projection of the legacy `governanceQuality` metadata field.
 * These are descriptive categories, not an ordinal safety ladder.
 */
export const CONTROL_POSTURE_STYLES: Record<GovernanceQuality, ControlPostureStyle> = {
  "immutable-code": {
    label: "Immutable code",
    shortLabel: "Immutable",
    stripLabel: "Code",
    badgeClassName: "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-400",
    activeCellClassName: "bg-blue-500/10 text-blue-800 ring-1 ring-inset ring-blue-500/30 dark:text-blue-300",
    iconClassName: "text-blue-700 dark:text-blue-400",
  },
  "dao-governance": {
    label: "DAO governed",
    shortLabel: "DAO",
    stripLabel: "DAO",
    badgeClassName: "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    activeCellClassName:
      "bg-emerald-500/10 text-emerald-800 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300",
    iconClassName: "text-emerald-700 dark:text-emerald-400",
  },
  multisig: {
    label: "Multisig controlled",
    shortLabel: "Multisig",
    stripLabel: "Multisig",
    badgeClassName: "border-cyan-500/25 bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
    activeCellClassName: "bg-cyan-500/10 text-cyan-800 ring-1 ring-inset ring-cyan-500/30 dark:text-cyan-300",
    iconClassName: "text-cyan-700 dark:text-cyan-400",
  },
  "regulated-entity": {
    label: "Regulated entity",
    shortLabel: "Regulated",
    stripLabel: "Regulated",
    badgeClassName: "border-indigo-500/25 bg-indigo-500/10 text-indigo-700 dark:text-indigo-400",
    activeCellClassName:
      "bg-indigo-500/10 text-indigo-800 ring-1 ring-inset ring-indigo-500/30 dark:text-indigo-300",
    iconClassName: "text-indigo-700 dark:text-indigo-400",
  },
  "single-entity": {
    label: "Single operator",
    shortLabel: "Operator",
    stripLabel: "Operator",
    badgeClassName: "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    activeCellClassName: "bg-amber-500/10 text-amber-800 ring-1 ring-inset ring-amber-500/30 dark:text-amber-300",
    iconClassName: "text-amber-700 dark:text-amber-400",
  },
  wrapper: {
    label: "Wrapper / inherited",
    shortLabel: "Wrapper",
    stripLabel: "Wrapper",
    badgeClassName: "border-border/70 bg-muted/40 text-muted-foreground",
    activeCellClassName: "bg-muted/70 text-foreground ring-1 ring-inset ring-border",
    iconClassName: "text-muted-foreground",
  },
};

export const CONTROL_POSTURE_ORDER = [
  "immutable-code",
  "dao-governance",
  "multisig",
  "regulated-entity",
  "single-entity",
  "wrapper",
] as const satisfies readonly GovernanceQuality[];
