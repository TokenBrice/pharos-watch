import type { CoverageBreakdownItem, CoverageFeatureKey, CoverageFeatureSummary } from "@/lib/coverage";
import {
  COVERAGE_BREAKDOWN_VISUAL_CLASSES,
  COVERAGE_GAP_BAR_CLASS,
  FEATURE_ACCENT_CLASSES,
  FEATURE_ICON,
} from "@/lib/coverage-page-config";
import { cn } from "@/lib/utils";
import { CoverageFeatureLink } from "@/components/coverage/coverage-feature-link";

const PRICE_SOURCE_DEPTH_KEYS = new Set(["sources-5-plus", "sources-3-4", "sources-1-2"]);
const BAR_TEXT_ON_DARK_CLASS = "text-white";
const GAP_BAR_SURFACE_CLASS =
  "bg-muted text-foreground bg-[repeating-linear-gradient(135deg,transparent_0_5px,var(--border)_5px_6px)]";
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
}

function getStackedBarItems(summary: CoverageFeatureSummary): CoverageBreakdownItem[] {
  const nonZeroItems = summary.breakdown.filter((item) => item.count > 0);

  if (summary.feature.key === "mintAuthority") {
    return nonZeroItems.filter((item) => !item.key.startsWith("score-"));
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

export function CoverageFeatureSnapshotRow({ summary }: CoverageFeatureSnapshotRowProps) {
  const Icon = FEATURE_ICON[summary.feature.key];
  const accent = FEATURE_ACCENT_CLASSES[summary.feature.key];
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

  return (
    <li
      className={cn(
        "grid gap-4 bg-card px-4 py-4 transition-colors hover:bg-muted/10 md:grid-cols-[minmax(11.5rem,0.85fr)_minmax(0,2fr)_minmax(11.5rem,0.7fr)] md:items-center md:px-5",
      )}
    >
      <div className="min-w-0">
        <CoverageFeatureLink
          feature={summary.feature}
          className={cn(
            "inline-flex min-w-0 items-center gap-3 rounded-md",
            summary.feature.href ? "pharos-focus-ring text-foreground hover:text-foreground" : "text-foreground",
          )}
        >
          <Icon className={cn("h-5 w-5 shrink-0", accent.icon)} aria-hidden="true" />
          <span className="min-w-0">
            <span
              className={cn(
                "block truncate text-sm font-semibold leading-tight tracking-tight",
                accent.title,
              )}
            >
              {summary.feature.label}
            </span>
            <span className="mt-0.5 block truncate text-2xs leading-tight text-muted-foreground">
              {summary.countLabel}
            </span>
          </span>
          <span className="sr-only">: {summary.feature.description}</span>
        </CoverageFeatureLink>
      </div>

      <div className="min-w-0">
        <div
          className="relative flex h-10 overflow-hidden rounded-md border border-border/60 bg-muted/65"
          role="img"
          aria-label={`${summary.feature.label} coverage: ${segmentLabel}`}
        >
          {barItems.map((item) => {
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
            return (
              <div
                key={`${summary.feature.key}-${item.key}-bar`}
                className={cn(
                  "flex h-full min-w-0 items-center justify-center border-r border-card/80 px-1.5 last:border-r-0",
                  isGapBar ? GAP_BAR_SURFACE_CLASS : (visual?.bar ?? accent.countBar),
                )}
                style={{ flexGrow: item.count, flexBasis: 0 }}
                title={`${item.label}: ${item.count}`}
              >
                {barText ? (
                  <span
                    className={cn(
                      "whitespace-nowrap text-3xs font-semibold leading-none pharos-numeric",
                      isGapBar ? "text-foreground" : (visual?.barText ?? BAR_TEXT_ON_DARK_CLASS),
                    )}
                  >
                    {barText}
                  </span>
                ) : null}
              </div>
            );
          })}
          {missingCount > 0 ? (() => {
            const missingText = resolveBarSegmentLabel("not covered", missingCount, missingPct, "gap");
            return (
              <div
                className={cn(
                  "flex h-full min-w-0 items-center justify-center border-r border-card/80 px-1.5 last:border-r-0",
                  GAP_BAR_SURFACE_CLASS,
                )}
                style={{ flexGrow: missingCount, flexBasis: 0 }}
                title={`not covered: ${missingCount}`}
              >
                {missingText ? (
                  <span className="whitespace-nowrap text-3xs font-semibold leading-none text-foreground pharos-numeric">
                    {missingText}
                  </span>
                ) : null}
              </div>
            );
          })() : null}
        </div>
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
  accent: CoverageFeatureKey;
}

export function FeatureSnapshotInsight({ label, title, detail, accent }: FeatureSnapshotInsightProps) {
  const accentClasses = FEATURE_ACCENT_CLASSES[accent];

  return (
    <div className={cn("rounded-lg border px-3 py-2.5", accentClasses.tile)}>
      <div className="pharos-label">{label}</div>
      <div className={cn("mt-1 truncate text-sm font-semibold leading-tight", accentClasses.title)}>{title}</div>
      <div className="mt-1 pharos-numeric text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
