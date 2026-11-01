import type { LaunchMilestoneType, LaunchPhase } from "../../types/core";

/** Pre-launch phase, milestone and date-drift presentation. */

export const PRE_LAUNCH_PHASE_CLASSES = {
  announced: {
    dot: "bg-amber-500",
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
    orbit: "border-amber-500/35 bg-amber-500/[0.05] dark:border-amber-400/35 dark:bg-amber-400/[0.07]",
  },
  testnet: {
    dot: "bg-indigo-500",
    badge: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
    orbit: "border-indigo-500/35 bg-indigo-500/[0.05] dark:border-indigo-400/35 dark:bg-indigo-400/[0.07]",
  },
  auditing: {
    dot: "bg-violet-500",
    badge: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    orbit: "border-violet-500/35 bg-violet-500/[0.05] dark:border-violet-400/35 dark:bg-violet-400/[0.07]",
  },
  beta: {
    dot: "bg-emerald-500",
    badge: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    orbit: "border-emerald-500/35 bg-emerald-500/[0.05] dark:border-emerald-400/35 dark:bg-emerald-400/[0.07]",
  },
  "launching-soon": {
    dot: "bg-sky-500",
    badge: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    orbit: "border-sky-500/45 bg-sky-500/[0.07] dark:border-sky-400/45 dark:bg-sky-400/[0.09]",
  },
  launched: {
    dot: "bg-teal-500",
    badge: "border-teal-500/30 bg-teal-500/10 text-teal-600 dark:text-teal-400",
    orbit: "border-teal-500/35 bg-teal-500/[0.05] dark:border-teal-400/35 dark:bg-teal-400/[0.07]",
  },
} as const satisfies Record<LaunchPhase, { dot: string; badge: string; orbit: string }>;

/** Pre-launch detail page: pre-launch card and progress fill. */
export const PRE_LAUNCH_ACCENT_CLASSES = {
  preLaunchCard: { border: "border-indigo-500/25", bg: "bg-indigo-500/[0.06]", text: "text-indigo-600 dark:text-indigo-400" },
  progressFill: "bg-indigo-500/60",
} as const;

export const PRE_LAUNCH_MILESTONE_BADGE_CLASSES = {
  announcement: "border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  milestone: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  delay: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
  partnership: "border-purple-500/30 bg-purple-500/10 text-purple-600 dark:text-purple-400",
  regulatory: "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  audit: "border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  testnet: "border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400",
} as const satisfies Record<LaunchMilestoneType, string>;

export type PreLaunchDriftStatus = "on-track" | "pushed-once" | "pushed-multiple" | "overdue";

/** Amber = the target moved (stronger once it moved twice); red only once it expired. */
export const PRE_LAUNCH_DRIFT_BADGE_CLASSES = {
  "on-track": "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  "pushed-once": "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "pushed-multiple": "border-amber-500/55 bg-amber-500/20 text-amber-800 dark:text-amber-300",
  overdue: "border-red-500/30 bg-red-500/10 text-red-600 dark:text-red-400",
} as const satisfies Record<PreLaunchDriftStatus, string>;

/** Display-only drift state: an earlier target exists but none is current. Neutral: nothing to slip against. */
export const PRE_LAUNCH_NO_CURRENT_TARGET_BADGE_CLASS = "border-border/60 bg-muted/40 text-muted-foreground";

export const LAUNCH_PHASE_LABELS = {
  announced: "Announced",
  testnet: "Testnet",
  auditing: "Auditing",
  beta: "Beta",
  "launching-soon": "Launching soon",
  launched: "Launched – awaiting data",
} as const satisfies Record<LaunchPhase, string>;

/** A pre-launch coin whose launch phase has not been assigned. */
export const PRE_LAUNCH_UNPHASED_LABEL = "Unphased";

export const MILESTONE_TYPE_LABELS = {
  announcement: "Announcement",
  milestone: "Milestone",
  delay: "Delay",
  partnership: "Partnership",
  regulatory: "Regulatory",
  audit: "Audit",
  testnet: "Testnet",
} as const satisfies Record<LaunchMilestoneType, string>;

export const DRIFT_STATUS_LABEL = {
  "on-track": "On track",
  "pushed-once": "Pushed once",
  "pushed-multiple": "Delayed",
  overdue: "Overdue",
  "no-current-target": "No current target",
} as const satisfies Record<PreLaunchDriftStatus | "no-current-target", string>;
