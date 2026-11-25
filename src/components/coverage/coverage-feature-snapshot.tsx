import { Filter } from "lucide-react";
import type { CoverageBreakdownItem, CoverageFeatureSummary } from "@/lib/coverage";
import {
  COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  COVERAGE_BREAKDOWN_VISUAL_CLASSES,
  COVERAGE_GAP_BAR_CLASS,
  FEATURE_ACCENT_CLASSES,
  FEATURE_ICON,
} from "@/lib/coverage-page-config";
import {
  COVERAGE_FEATURE_SNAPSHOT_FILTERS,
  type CoverageMatrixFilterKey,
} from "@/components/coverage/coverage-matrix-controls";
import { DisclosurePanel } from "@/components/disclosure-panel";
import { cn } from "@/lib/utils";
import { CoverageFeatureLink } from "@/components/coverage/coverage-feature-link";

const PRICE_SOURCE_DEPTH_KEYS = new Set(["sources-5-plus", "sources-3-4", "sources-1-2"]);
const BAR_TEXT_ON_DARK_CLASS = "text-white";
const BAR_LABEL_MIN_PCT = 8;

/**
 * Only print text inside a stacked-bar slice when the slice is wide enough to
 * render the label cleanly without mid-word ellipsis ("not cover..."). Full
 * labels always remain in `title` and the bar's `aria-label`.
 */
function resolveBarSegmentLabel(
  label: string,
  count: number,
  pct: number,
  compactFallback?: string,
): string | null {
  const full = `${label} ${count}`;
  if (pct >= Math.max(BAR_LABEL_MIN_PCT, full.length * 1.4)) return full;
  if (compactFallback) {
    const compact = `${compactFallback} ${count}`;
    if (pct >= Math.max(BAR_LABEL_MIN_PCT, compact.length * 1.4)) return compact;
  }
  const numericOnly = String(count);
  if (pct >= BAR_LABEL_MIN_PCT && pct >= numericOnly.length * 2.2) return numericOnly;
  return null;
}
const BAR_LABELS: Partial<Record<string, string>> = {
  "sources-5-plus": "5+",
  "sources-3-4": "3-4",
  "sources-1-2": "0-2",
  "price-only": "price",
  "data-unavailable": "n/a",
  rated: "rated",
  "not-graded": "ungraded",
  nr: "NR",
  primary: "primary",
  mixed: "mixed",
  fallback: "fallback",
  legacy: "legacy",
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
  uncovered: "not covered",
  full: "full",
  "partial-history": "partial",
  tracked: "tracked",
  bootstrapping: "boot",
  unknown: "unknown",
  yes: "yes",
  upstream: "upstr",
  possible: "poss",
  no: "no",
  authorized: "auth",
  pending: "pend",
  transitional: "trans",
  "non-compliant": "non-comp",
  "out-of-scope": "out",
  unassessed: "not assessed",
  "ppsi-approved": "PPSI",
  "state-qualified": "state",
  "official-application-pending": "filing",
  "issuer-announced-intent": "intent",
  "no-public-authorization-found": "none",
  "not-applicable": "N/A",
};

export interface CoverageFeatureSnapshotRowProps {
  summary: CoverageFeatureSummary;
  onFilterFeature?: (filter: CoverageMatrixFilterKey) => void;
}

function getStackedBarItems(summary: CoverageFeatureSummary): CoverageBreakdownItem[] {
  const nonZeroItems = summary.breakdown.filter((item) => item.count > 0);

  if (summary.feature.key === "mintAuthority") {
    return nonZeroItems.filter((item) => !item.key.startsWith("score-"));
  }

  if (summary.feature.key === "safety") {
    // Intentionally ungraded tokenized funds sit outside the Safety denominator,
    // so only gradable rows plus any technical data-unavailable segment stack.
    const gradableItems = summary.denominatorBreakdown.filter((item) => item.count > 0);
    const unavailableItem = summary.breakdown.find((item) => item.key === "data-unavailable" && item.count > 0);
    return unavailableItem ? [...gradableItems, unavailableItem] : gradableItems;
  }

  if (summary.feature.key !== "price") {
    return nonZeroItems;
  }

  // The price denominator admits only observed-depth Tracked rows plus Missing
  // rows, so NAV price-only and unknown-depth rows must not be stacked. Data
  // n/a stays visible like every other feature's outage segment, and the
  // caller subtracts it from the not-covered gap.
  const depthItems = summary.denominatorBreakdown.filter(
    (item) => item.count > 0 && PRICE_SOURCE_DEPTH_KEYS.has(item.key),
  );
  const unavailableItem = summary.breakdown.find((item) => item.key === "data-unavailable" && item.count > 0);
  return unavailableItem ? [...depthItems, unavailableItem] : depthItems;
}

export function CoverageFeatureSnapshotRow({
  summary,
  onFilterFeature,
}: CoverageFeatureSnapshotRowProps) {
  const Icon = FEATURE_ICON[summary.feature.key];
  const accent = FEATURE_ACCENT_CLASSES[summary.feature.key];
  const matrixFilter = COVERAGE_FEATURE_SNAPSHOT_FILTERS[summary.feature.key];
  const barItems = getStackedBarItems(summary);
  const stackedCount = barItems.reduce((total, item) => total + item.count, 0);
  // "Not covered" is derived from what the bar actually stacks: the shared
  // data-unavailable segment renders its own bucket and must never be
  // published as a coverage gap.
  const unavailableCount = barItems.find((item) => item.key === "data-unavailable")?.count ?? 0;
  const missingCount = Math.max(summary.totalCount - (stackedCount - unavailableCount), 0);
  const barTotalCount = stackedCount + missingCount;
  const missingPct = barTotalCount > 0 ? (missingCount / barTotalCount) * 100 : 0;
  const marketCapLabel = summary.mcapSharePct == null ? "n/a" : `${summary.mcapSharePct.toFixed(0)}%`;
  const coverageLabel =
    summary.coveragePct == null
      ? summary.coverageUnavailable
        ? "Data n/a"
        : "n/a"
      : `${summary.coveragePct.toFixed(0)}%`;
  const segmentLabel = [
    ...barItems.map((item) => `${item.label} ${item.count}`),
    missingCount > 0 ? `not covered ${missingCount}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  const segments = [
    ...barItems.map((item) => {
      const visual = COVERAGE_BREAKDOWN_VISUAL_CLASSES[summary.feature.key]?.[item.key];
      const pct = barTotalCount > 0 ? (item.count / barTotalCount) * 100 : 0;
      const visibleLabel = BAR_LABELS[item.key] ?? item.label;
      const barText = resolveBarSegmentLabel(
        visibleLabel,
        item.count,
        pct,
        item.key === "uncovered" ? "gap" : item.key === "unassessed" ? "none" : undefined,
      );
      const isGapBar = visual?.bar === COVERAGE_GAP_BAR_CLASS;
      return {
        key: `${summary.feature.key}-${item.key}-bar`,
        label: item.label,
        count: item.count,
        barText,
        barClass: isGapBar ? COVERAGE_GAP_BAR_CLASS : (visual?.bar ?? accent.countBar),
        textClass: isGapBar
          ? "text-foreground"
          : visual
            ? (visual.barText ?? BAR_TEXT_ON_DARK_CLASS)
            : COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
      };
    }),
    ...(missingCount > 0
      ? [
          {
            key: `${summary.feature.key}-missing-bar`,
            label: "not covered",
            count: missingCount,
            barText: resolveBarSegmentLabel("not covered", missingCount, missingPct, "gap"),
            barClass: COVERAGE_GAP_BAR_CLASS,
            textClass: "text-foreground",
          },
        ]
      : []),
  ];
  const hiddenSegmentCount = segments.filter((segment) => segment.barText == null).length;

  return (
    <li
      className={cn(
        "grid gap-4 bg-card px-4 py-4 transition-colors hover:bg-muted/10 md:grid-cols-[minmax(11.5rem,0.85fr)_minmax(0,2fr)_minmax(11.5rem,0.7fr)] md:items-center md:px-5",
      )}
    >
      <div className="flex min-w-0 items-center justify-between gap-2 md:block">
        <CoverageFeatureLink
          feature={summary.feature}
          className={cn(
            "inline-flex min-w-0 items-center gap-3 rounded-md",
            summary.feature.href ? "pharos-focus-ring text-foreground hover:text-foreground" : "text-foreground",
          )}
        >
          <Icon className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-tight tracking-tight text-foreground">
              {summary.feature.label}
            </span>
            <span className="mt-0.5 block truncate text-2xs leading-tight text-muted-foreground">
              {summary.countLabel}
            </span>
          </span>
          <span className="sr-only">: {summary.feature.description}</span>
        </CoverageFeatureLink>
        {onFilterFeature ? (
          <div className="shrink-0 md:mt-2">
            <button
              type="button"
              onClick={() => onFilterFeature(matrixFilter.filter)}
              aria-label={matrixFilter.ariaLabel}
              className="pharos-focus-ring pharos-control-pill min-h-11 gap-1.5 px-2.5 py-1 text-2xs font-medium text-muted-foreground hover:text-foreground sm:h-7 sm:min-h-0"
            >
              <Filter className="h-3 w-3 shrink-0" aria-hidden="true" />
              <span>{matrixFilter.label}</span>
            </button>
          </div>
        ) : null}
      </div>

      <div className="min-w-0">
        <div
          className="relative flex h-10 overflow-hidden rounded-md border border-border/60 bg-muted/65"
          role="img"
          aria-label={`${summary.feature.label} coverage: ${segmentLabel}`}
        >
          {segments.map((segment) => (
            <div
              key={segment.key}
              className={cn(
                "flex h-full min-w-0 items-center justify-center border-r border-card/80 px-1.5 last:border-r-0",
                segment.barClass,
              )}
              style={{ flexGrow: segment.count, flexBasis: 0 }}
              title={`${segment.label}: ${segment.count}`}
            >
              {segment.barText ? (
                <span
                  className={cn(
                    "whitespace-nowrap text-3xs font-semibold leading-none pharos-numeric",
                    segment.textClass,
                  )}
                >
                  {segment.barText}
                </span>
              ) : null}
            </div>
          ))}
        </div>

        {hiddenSegmentCount > 0 ? (
          <DisclosurePanel
            variant="plain"
            className="mt-1.5"
            summary={
              <span>
                Breakdown ({segments.length} segments · {hiddenSegmentCount} narrow)
              </span>
            }
            summaryClassName="min-h-8 text-2xs sm:min-h-7"
            contentClassName="mt-1.5"
          >
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {segments.map((segment) => (
                <li key={`${segment.key}-legend`} className="pharos-chart-legend-chip">
                  <span
                    aria-hidden="true"
                    className={cn("h-2 w-2 shrink-0 rounded-xs border border-border/50", segment.barClass)}
                  />
                  <span>{segment.label}</span>
                  <span className="pharos-numeric font-medium text-foreground">{segment.count}</span>
                </li>
              ))}
            </ul>
          </DisclosurePanel>
        ) : null}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 md:justify-self-end">
        <div className="min-w-0 md:text-right">
          <div className="pharos-numeric text-2xl font-semibold leading-none text-foreground">
            {summary.availableCount}
            <span className="ml-0.5 text-sm font-medium text-muted-foreground">/{summary.totalCount}</span>
          </div>
          <div className="mt-1.5 pharos-label">
            <span className="pharos-numeric">{coverageLabel}</span>{" "}
            count
          </div>
        </div>
        <div className="min-w-0 md:text-right">
          <div className="pharos-numeric text-2xl font-semibold leading-none text-foreground">
            {marketCapLabel}
          </div>
          <div className="mt-1.5 pharos-label">
            {summary.marketCapComplete ? "of cap" : "of known cap"}
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
}

export function FeatureSnapshotInsight({ label, title, detail }: FeatureSnapshotInsightProps) {
  return (
    <div className="pharos-inset px-3 py-2.5">
      <div className="pharos-label">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold leading-tight text-foreground">{title}</div>
      <div className="mt-1 pharos-numeric text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
