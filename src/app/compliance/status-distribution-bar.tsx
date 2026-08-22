import Link from "next/link";
import { cn } from "@/lib/utils";
import { GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES } from "@shared/lib/genius";
import { MICA_STATUS_BADGE_STYLES } from "@shared/lib/mica";
import type { GeniusAuthorizationStatus, MicaStatus } from "@shared/types";
import type { ComplianceStatusDistribution } from "@/lib/compliance-model";

interface DistributionSegment {
  key: string;
  label: string;
  count: number;
  href: string;
  colorClassName: string;
}

const MICA_SEGMENT_COLOR_CLASSES: Record<MicaStatus, string> = {
  authorized: "bg-green-600",
  pending: "bg-amber-600",
  transitional: "bg-cyan-600",
  "non-compliant": "bg-red-600",
  "out-of-scope": "bg-gray-400 dark:bg-gray-500",
};

const GENIUS_SEGMENT_COLOR_CLASSES: Partial<Record<GeniusAuthorizationStatus, string>> = {
  "ppsi-approved": "bg-green-600",
  "state-qualified": "bg-violet-600",
  "official-application-pending": "bg-amber-600",
  "issuer-announced-intent": "bg-blue-600",
};

const GENIUS_NEUTRAL_STATUSES = new Set<GeniusAuthorizationStatus>([
  "no-public-authorization-found",
  "unknown",
  "not-applicable",
]);

function buildMicaSegments(distribution: ComplianceStatusDistribution["mica"]): DistributionSegment[] {
  return distribution.map(({ status, count }) => ({
    key: status,
    label: MICA_STATUS_BADGE_STYLES[status].label,
    count,
    href: `/compliance/?regime=mica&status=${status}`,
    colorClassName: MICA_SEGMENT_COLOR_CLASSES[status],
  }));
}

function buildGeniusSegments(distribution: ComplianceStatusDistribution["genius"]): DistributionSegment[] {
  const signalSegments = distribution.flatMap(({ status, count }) => {
    const colorClassName = GENIUS_SEGMENT_COLOR_CLASSES[status];
    if (!colorClassName) return [];
    return [{
      key: status,
      label: GENIUS_AUTHORIZATION_STATUS_BADGE_STYLES[status].label,
      count,
      href: `/compliance/?regime=genius&status=${status}`,
      colorClassName,
    }];
  });
  const neutralCount = distribution.reduce(
    (total, item) => total + (GENIUS_NEUTRAL_STATUSES.has(item.status) ? item.count : 0),
    0,
  );
  if (neutralCount === 0) return signalSegments;
  return [
    ...signalSegments,
    {
      key: "no-public-signal",
      label: "No public signal",
      count: neutralCount,
      href: "/compliance/?regime=genius&status=all",
      colorClassName: "bg-gray-400 dark:bg-gray-500",
    },
  ];
}

function StatusDistributionBar({
  label,
  segments,
}: {
  label: string;
  segments: DistributionSegment[];
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  if (total === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold text-foreground">{label}</p>
        <p className="pharos-numeric text-[11px] text-muted-foreground">{total.toLocaleString()} assessed</p>
      </div>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full bg-transparent">
        {segments.map((segment) => {
          const title = `${segment.label} — ${segment.count.toLocaleString()} of ${total.toLocaleString()}`;
          return (
            <Link
              key={segment.key}
              href={segment.href}
              title={title}
              aria-label={`${title}; filter the compliance tracker`}
              className={cn("pharos-focus-ring block h-full min-w-[6px]", segment.colorClassName)}
              style={{ width: `${(segment.count / total) * 100}%` }}
            >
              <span className="sr-only">{title}</span>
            </Link>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((segment) => (
          <span key={segment.key} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn("h-2 w-2 shrink-0 rounded-full", segment.colorClassName)} aria-hidden="true" />
            <span>{segment.label}</span>
            <span className="pharos-numeric">{segment.count.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function ComplianceStatusDistributionBars({
  distribution,
}: {
  distribution: ComplianceStatusDistribution;
}) {
  const micaSegments = buildMicaSegments(distribution.mica);
  const geniusSegments = buildGeniusSegments(distribution.genius);

  return (
    <div className="grid gap-5 border-t border-border/50 p-5 sm:p-6 lg:grid-cols-2">
      <StatusDistributionBar label="MiCA" segments={micaSegments} />
      <StatusDistributionBar label="GENIUS" segments={geniusSegments} />
    </div>
  );
}
