import { formatCompactCount } from "@shared/lib/format";
import type { ConditionBand } from "@shared/lib/psi-colors";
import { PSI_BORDER_CLASSES } from "@shared/lib/psi-colors";
import { getDisplayedPsi } from "@shared/lib/psi-view-model";
import type {
  BlacklistSummaryResponse,
  HealthResponse,
  PegSummaryResponse,
  StabilityIndexResponse,
} from "@shared/types";

export interface SidebarNavSignal {
  kind: "badge" | "dot" | "accent";
  text?: string;
  title: string;
  tone: "neutral" | "info" | "healthy" | "warning" | "danger";
  /** Tailwind border-l class for accent-colored left border overlay. */
  accentClass?: string;
}

export const SIDEBAR_DIGEST_SEEN_STORAGE_KEY = "pharos-sidebar-digest-seen-generated-at";

function getPsiSignalTone(band: string): SidebarNavSignal["tone"] {
  switch (band as ConditionBand) {
    case "BEDROCK":
    case "STEADY":
      return "healthy";
    case "TREMOR":
    case "FRACTURE":
      return "warning";
    case "CRISIS":
    case "MELTDOWN":
      return "danger";
    default:
      return "neutral";
  }
}

function formatDigestSeenTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

export function parseSidebarDigestSeenAt(value: string | null): number | null {
  return formatDigestSeenTimestamp(value);
}

export function getDepegNavSignal(pegSummary: PegSummaryResponse | null | undefined): SidebarNavSignal | null {
  const activeDepegCount = pegSummary?.summary?.activeDepegCount ?? 0;
  if (activeDepegCount <= 0) return null;

  return {
    kind: "badge",
    text: formatCompactCount(activeDepegCount),
    title: `${activeDepegCount} active depeg incident${activeDepegCount === 1 ? "" : "s"}`,
    tone: "danger",
  };
}

export function getStabilityIndexNavSignal(stabilityIndex: StabilityIndexResponse | null | undefined): SidebarNavSignal | null {
  const current = stabilityIndex?.current;
  if (!current) return null;

  const displayed = getDisplayedPsi(current);
  return {
    kind: "accent",
    title: `PSI ${displayed.score.toFixed(1)} (${displayed.band})`,
    tone: getPsiSignalTone(displayed.band),
    accentClass: PSI_BORDER_CLASSES[displayed.band as ConditionBand],
  };
}

export function getBlacklistNavSignal(blacklistSummary: BlacklistSummaryResponse | null | undefined): SidebarNavSignal | null {
  const recentCount24h = blacklistSummary?.stats.recentCount24h ?? 0;
  if (recentCount24h <= 0) return null;

  return {
    kind: "badge",
    text: formatCompactCount(recentCount24h),
    title: `${recentCount24h} blacklist event${recentCount24h === 1 ? "" : "s"} in the last 24h`,
    tone: "warning",
  };
}

export function getStatusNavSignal(health: HealthResponse | null | undefined): SidebarNavSignal | null {
  if (!health) return null;

  return {
    kind: "dot",
    title: `System status: ${health.status}`,
    tone:
      health.status === "healthy"
        ? "healthy"
        : health.status === "degraded"
          ? "warning"
          : "danger",
  };
}

export function hasUnreadDigest(
  latestGeneratedAt: number | null | undefined,
  seenGeneratedAt: number | null,
): boolean {
  return typeof latestGeneratedAt === "number" && latestGeneratedAt > (seenGeneratedAt ?? 0);
}

export function getDigestNavSignal(
  latestGeneratedAt: number | null | undefined,
  seenGeneratedAt: number | null,
): SidebarNavSignal | null {
  if (!hasUnreadDigest(latestGeneratedAt, seenGeneratedAt)) return null;

  return {
    kind: "badge",
    text: "new",
    title: "New daily digest available",
    tone: "info",
  };
}
