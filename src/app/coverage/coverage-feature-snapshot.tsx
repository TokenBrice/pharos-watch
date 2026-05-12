import type { CoverageBreakdownItem, CoverageFeatureKey, CoverageFeatureSummary } from "@/lib/coverage";
import { COVERAGE_BREAKDOWN_VISUAL_CLASSES, FEATURE_ACCENT_CLASSES, FEATURE_ICON } from "@/lib/coverage-page-config";
import { cn } from "@/lib/utils";
import { CoverageFeatureLink } from "./coverage-feature-link";

const PRICE_SOURCE_DEPTH_KEYS = new Set(["sources-5-plus", "sources-3-4", "sources-1-2"]);
const DEFAULT_MUTED_BAR_CLASS = "bg-muted-foreground/35";
const BAR_TEXT_CLASS = "text-white [text-shadow:0_1px_2px_oklch(0_0_0_/0.75)]";
const BAR_LABEL_MIN_PCT = 8;
const BAR_LABELS: Partial<Record<string, string>> = {
  "sources-5-plus": "5+",
  "sources-3-4": "3-4",
  "sources-1-2": "1-2",
  "price-only": "price",
  "data-unavailable": "n/a",
  rated: "rated",
  nr: "NR",
  primary: "primary",
  mixed: "mixed",
  fallback: "fallback",
  live: "live",
  "live-configured": "config",
  checking: "check",
  "curated-validated": "valid",
  proof: "proof",
  curated: "curated",
  estimated: "est",
  "modeled-heuristic": "heur",
  "configured-unrated": "config",
  "offchain-issuer": "issuer",
  "psm-swap": "PSM",
  "queue-redeem": "queue",
  "collateral-redeem": "collat",
  "stablecoin-redeem": "stable",
  "basket-redeem": "basket",
  covered: "covered",
  uncovered: "gap",
  full: "full",
  "partial-history": "partial",
  lagging: "lag",
  bootstrapping: "boot",
  yes: "yes",
  dilutable: "dilute",
  upstream: "upstr",
  possible: "poss",
  no: "no",
};

export interface CoverageFeatureSnapshotRowProps {
  summary: CoverageFeatureSummary;
}

function getStackedBarItems(summary: CoverageFeatureSummary): CoverageBreakdownItem[] {
  const nonZeroItems = summary.breakdown.filter((item) => item.count > 0);

  if (summary.feature.key !== "price") {
    return nonZeroItems;
  }

  const sourceDepthItems = nonZeroItems.filter((item) => PRICE_SOURCE_DEPTH_KEYS.has(item.key));
  if (sourceDepthItems.length === 0) {
    return nonZeroItems;
  }

  const priceOnlyItem = nonZeroItems.find((item) => item.key === "price-only");
  const unavailableItem = nonZeroItems.find((item) => item.key === "data-unavailable");
  return [...sourceDepthItems, priceOnlyItem, unavailableItem].filter((item): item is CoverageBreakdownItem => !!item);
}

export function CoverageFeatureSnapshotRow({ summary }: CoverageFeatureSnapshotRowProps) {
  const Icon = FEATURE_ICON[summary.feature.key];
  const accent = FEATURE_ACCENT_CLASSES[summary.feature.key];
  const barItems = getStackedBarItems(summary);
  const stackedCount = barItems.reduce((total, item) => total + item.count, 0);
  const missingCount = Math.max(summary.totalCount - stackedCount, 0);
  const marketCapLabel = summary.mcapSharePct == null ? "n/a" : `${summary.mcapSharePct.toFixed(0)}%`;
  const segmentLabel = [
    ...barItems.map((item) => `${item.label} ${item.count}`),
    missingCount > 0 ? `not covered ${missingCount}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li
      className={cn(
        "relative grid gap-3 bg-card px-4 py-4 transition-colors before:absolute before:inset-y-3 before:left-0 before:w-[3px] hover:bg-muted/10 md:grid-cols-[minmax(10rem,0.7fr)_minmax(0,2fr)_minmax(13rem,0.75fr)] md:items-center md:px-5",
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
            className={cn("inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border", accent.ring)}
          >
            <Icon className={cn("h-4 w-4", accent.icon)} aria-hidden="true" />
          </span>
          <span className="min-w-0">
            <span className={cn("block truncate text-sm font-semibold leading-tight", accent.title)}>
              {summary.feature.label}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{summary.countLabel}</span>
          </span>
          <span className="sr-only">: {summary.feature.description}</span>
        </CoverageFeatureLink>
      </div>

      <div className="min-w-0 space-y-2">
        <div
          className="relative flex h-9 overflow-hidden rounded-lg border border-border/70 bg-muted/70"
          role="img"
          aria-label={`${summary.feature.label} coverage: ${segmentLabel}`}
        >
          {barItems.map((item) => {
            const visual = COVERAGE_BREAKDOWN_VISUAL_CLASSES[summary.feature.key]?.[item.key];
            const pct = summary.totalCount > 0 ? (item.count / summary.totalCount) * 100 : 0;
            const showLabel = pct >= BAR_LABEL_MIN_PCT;
            const visibleLabel = BAR_LABELS[item.key] ?? item.label;
            return (
              <div
                key={`${summary.feature.key}-${item.key}-bar`}
                className={cn(
                  "flex h-full min-w-0 items-center justify-center border-r border-card/85 px-1 last:border-r-0",
                  visual?.bar ?? accent.countBar,
                )}
                style={{ flexGrow: item.count, flexBasis: 0 }}
                title={`${item.label}: ${item.count}`}
              >
                {showLabel ? (
                  <span
                    className={cn(
                      "truncate text-[10px] font-semibold leading-none tabular-nums drop-shadow-sm",
                      BAR_TEXT_CLASS,
                    )}
                  >
                    {visibleLabel} {item.count}
                  </span>
                ) : null}
              </div>
            );
          })}
          {missingCount > 0 ? (
            <div
              className={cn(
                "h-full border-r border-card/80 bg-background/80 last:border-r-0",
                barItems.length === 0 && DEFAULT_MUTED_BAR_CLASS,
              )}
              style={{ flexGrow: missingCount, flexBasis: 0 }}
              title={`Not covered: ${missingCount}`}
            />
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-[minmax(6rem,0.9fr)_minmax(5.5rem,0.75fr)] md:items-center md:justify-self-end">
        <div className="min-w-0">
          <div className="font-mono text-2xl font-semibold leading-none tabular-nums text-foreground">
            {summary.availableCount}
            <span className="text-sm text-muted-foreground">/{summary.totalCount}</span>
          </div>
          <div className="mt-1 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            {summary.coveragePct.toFixed(0)}% count
          </div>
        </div>
        <div className="min-w-0">
          <div className="font-mono text-xl font-semibold leading-none tabular-nums text-foreground">
            {marketCapLabel}
          </div>
          <div className="mt-1 text-[11px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
            market cap
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-frost-blue/12">
            <div
              className="h-full rounded-full bg-frost-blue/75"
              style={{
                width: `${summary.mcapSharePct && summary.mcapSharePct > 0 ? Math.max(summary.mcapSharePct, 2) : 0}%`,
              }}
            />
          </div>
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
    <div className={cn("rounded-lg border px-3 py-2.5", accentClasses.tile)}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className={cn("mt-1 truncate text-sm font-semibold leading-tight", accentClasses.title)}>{title}</div>
      <div className="mt-1 font-mono text-xs tabular-nums text-muted-foreground">{detail}</div>
    </div>
  );
}
