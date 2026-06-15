import { formatCompactCount } from "@shared/lib/format";
import type {
  BlacklistSummaryResponse,
  HealthResponse,
  PegSummaryResponse,
} from "@shared/types";

export interface SidebarNavSignal {
  kind: "badge" | "dot" | "accent";
  text?: string;
  title: string;
  tone: "neutral" | "info" | "healthy" | "warning" | "danger";
  showIcon?: boolean;
  /** Tailwind border-l class for accent-colored left border overlay. */
  accentClass?: string;
}

export const SIDEBAR_DIGEST_SEEN_STORAGE_KEY = "pharos-sidebar-digest-seen-generated-at";


export function parseSidebarDigestSeenAt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
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

export function getTapeNavSignal(pegSummary: PegSummaryResponse | null | undefined): SidebarNavSignal | null {
  // /tape reuses the active-depeg count as its open-incident heartbeat: every
  // unresolved depeg in the latest window surfaces on the unified feed as a
  // currently-open card. A dot (not a count) keeps the signal distinct from
  // /depeg, which already shows the exact count badge.
  const activeDepegCount = pegSummary?.summary?.activeDepegCount ?? 0;
  if (activeDepegCount <= 0) return null;
  return {
    kind: "dot",
    title: `${activeDepegCount} open incident${activeDepegCount === 1 ? "" : "s"} on the tape`,
    tone: "warning",
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
    showIcon: false,
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
