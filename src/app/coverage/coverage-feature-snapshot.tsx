import type { CoverageFeatureKey, CoverageFeatureSummary } from "@/lib/coverage";
import { FEATURE_ACCENT_CLASSES, FEATURE_ICON } from "@/lib/coverage-page-config";
import { cn } from "@/lib/utils";
import { CoverageFeatureLink } from "./coverage-feature-link";

export interface CoverageFeatureSnapshotRowProps {
  summary: CoverageFeatureSummary;
}

export function CoverageFeatureSnapshotRow({ summary }: CoverageFeatureSnapshotRowProps) {
  const Icon = FEATURE_ICON[summary.feature.key];
  const accent = FEATURE_ACCENT_CLASSES[summary.feature.key];
  const breakdownItems = summary.breakdown.split("\u00b7").map((item) => item.trim());

  return (
    <li
      className={cn(
        "relative grid gap-4 overflow-hidden rounded-xl border border-border/60 bg-card px-4 py-4 before:absolute before:inset-y-4 before:left-0 before:w-[2px] xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1.35fr)_minmax(15rem,0.9fr)]",
        accent.rail,
      )}
    >
      <div className="min-w-0">
        <CoverageFeatureLink
          feature={summary.feature}
          className={cn(
            "inline-flex min-w-0 items-center gap-2 rounded-md",
            summary.feature.href ? "pharos-focus-ring text-foreground hover:text-foreground" : "text-foreground",
          )}
        >
          <span
            className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border", accent.ring)}
          >
            <Icon className={cn("h-4 w-4", accent.icon)} aria-hidden="true" />
          </span>
          <span className={cn("truncate text-sm font-semibold", accent.title)}>{summary.feature.label}</span>
        </CoverageFeatureLink>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{summary.feature.description}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>{summary.countLabel}</span>
            <span className="font-mono text-base font-semibold tracking-tight text-foreground">
              {summary.availableCount}/{summary.totalCount}
            </span>
          </div>
          <div className="h-2 rounded-full bg-muted/80">
            <div
              className={cn("h-full rounded-full", accent.countBar)}
              style={{ width: `${summary.coveragePct > 0 ? Math.max(summary.coveragePct, 4) : 0}%` }}
            />
          </div>
          <div className="text-xs text-muted-foreground">{summary.coverageLabel}</div>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>Market Share</span>
            <span className="font-mono text-base font-semibold tracking-tight text-foreground">
              {summary.mcapSharePct == null ? "\u2014" : `${summary.mcapSharePct.toFixed(0)}%`}
            </span>
          </div>
          <div className="h-2 rounded-full bg-frost-blue/12">
            <div
              className="h-full rounded-full bg-frost-blue/75"
              style={{
                width: `${summary.mcapSharePct && summary.mcapSharePct > 0 ? Math.max(summary.mcapSharePct, 4) : 0}%`,
              }}
            />
          </div>
          <div className="text-xs text-muted-foreground">{summary.shareLabel}</div>
        </div>
      </div>

      <div className="rounded-xl border border-border/60 bg-background/40 px-3 py-3">
        <div className="pharos-kicker">Breakdown</div>
        <div className="mt-2 flex flex-wrap gap-2">
          {breakdownItems.map((item, index) => (
            <span
              key={`${summary.feature.key}-${item}`}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-medium",
                index === 0 ? accent.chip : "border-border/60 bg-background/45 text-muted-foreground",
              )}
            >
              {item}
            </span>
          ))}
        </div>
      </div>
    </li>
  );
}

export interface FeatureSnapshotInsightProps {
  label: string;
  title: React.ReactNode;
  detail: React.ReactNode;
  accent: CoverageFeatureKey;
}

export function FeatureSnapshotInsight({ label, title, detail, accent }: FeatureSnapshotInsightProps) {
  const accentClasses = FEATURE_ACCENT_CLASSES[accent];

  return (
    <div className={cn("space-y-2 rounded-[1rem] border px-4 py-4", accentClasses.tile)}>
      <div className="pharos-kicker">{label}</div>
      <div className={cn("text-base font-semibold leading-tight", accentClasses.title)}>{title}</div>
      <div className="text-sm leading-relaxed text-muted-foreground">{detail}</div>
    </div>
  );
}
