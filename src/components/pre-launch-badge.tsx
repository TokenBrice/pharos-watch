import { DRIFT_STATUS_BADGE, DRIFT_STATUS_LABEL, LAUNCH_PHASE_LABELS, MILESTONE_TYPE_BADGE, MILESTONE_TYPE_LABELS, PHASE_BADGE, type DriftStatus } from "@/lib/pre-launch";
import type { LaunchMilestoneType, LaunchPhase } from "@shared/types";
type BadgeSize = "compact" | "detail";
const PHASE_BADGE_CLASSES: Record<BadgeSize, string> = { compact: "inline-flex rounded-full border px-2 py-1 text-[10px] font-medium leading-none", detail: "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium" };
const DRIFT_BADGE_CLASSES: Record<BadgeSize, string> = { compact: "inline-flex rounded-full border px-1.5 py-0.5 text-[9px] font-medium leading-none", detail: "inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium leading-none" };
const MILESTONE_BADGE_CLASS = "inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none";
export function LaunchPhaseBadge({ phase, size = "compact" }: { phase: LaunchPhase; size?: BadgeSize }) {
  return <span className={`${PHASE_BADGE_CLASSES[size]} ${PHASE_BADGE[phase]}`}>{LAUNCH_PHASE_LABELS[phase]}</span>;
}
export function LaunchDriftBadge({ status, size = "compact" }: { status: DriftStatus; size?: BadgeSize }) {
  return <span className={`${DRIFT_BADGE_CLASSES[size]} ${DRIFT_STATUS_BADGE[status]}`}>{DRIFT_STATUS_LABEL[status]}</span>;
}
export function LaunchMilestoneBadge({ type }: { type: LaunchMilestoneType }) {
  return <span className={`${MILESTONE_BADGE_CLASS} ${MILESTONE_TYPE_BADGE[type]}`}>{MILESTONE_TYPE_LABELS[type]}</span>;
}
