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
  uncovered: "not covered",
  full: "full",
  "partial-history": "partial",
  lagging: "lag",
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
  const missingPct = summary.totalCount > 0 ? (missingCount / summary.totalCount) * 100 : 0;
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
                "block truncate text-[15px] font-semibold leading-tight tracking-tight",
                accent.title,
              )}
            >
              {summary.feature.label}
            </span>
            <span className="mt-0.5 block truncate text-[11px] leading-tight text-muted-foreground">
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
            const pct = summary.totalCount > 0 ? (item.count / summary.totalCount) * 100 : 0;
            const showLabel = pct >= BAR_LABEL_MIN_PCT;
            const visibleLabel = BAR_LABELS[item.key] ?? item.label;
            return (
              <div
                key={`${summary.feature.key}-${item.key}-bar`}
                className={cn(
                  "flex h-full min-w-0 items-center justify-center border-r border-card/80 px-1.5 last:border-r-0",
                  visual?.bar ?? accent.countBar,
                )}
                style={{ flexGrow: item.count, flexBasis: 0 }}
                title={`${item.label}: ${item.count}`}
              >
                {showLabel ? (
                  <span
                    className={cn(
                      "truncate text-[10px] font-semibold leading-none tracking-[0.02em] pharos-numeric",
                      visual?.barText ?? BAR_TEXT_CLASS,
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
                "flex h-full min-w-0 items-center justify-center border-r border-card/80 px-1.5 last:border-r-0",
                COVERAGE_GAP_BAR_CLASS,
              )}
              style={{ flexGrow: missingCount, flexBasis: 0 }}
              title={`not covered: ${missingCount}`}
            >
              {missingPct >= BAR_LABEL_MIN_PCT ? (
                <span
                  className={cn(
                    "truncate text-[10px] font-semibold leading-none tracking-[0.02em] pharos-numeric",
                    BAR_TEXT_CLASS,
                  )}
                >
                  not covered {missingCount}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 md:justify-self-end">
        <div className="min-w-0 md:text-right">
          <div className="pharos-numeric text-2xl font-semibold leading-none text-foreground">
            {summary.availableCount}
            <span className="ml-0.5 text-sm font-medium text-muted-foreground">/{summary.totalCount}</span>
          </div>
          <div className="mt-1.5 pharos-kicker">
            <span className="pharos-numeric">{summary.coveragePct.toFixed(0)}%</span> count
          </div>
        </div>
        <div className="min-w-0 md:text-right">
          <div className="pharos-numeric text-2xl font-semibold leading-none text-foreground">
            {marketCapLabel}
          </div>
          <div className="mt-1.5 pharos-kicker">
            of cap
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
      <div className="pharos-kicker">{label}</div>
      <div className={cn("mt-1 truncate text-sm font-semibold leading-tight", accentClasses.title)}>{title}</div>
      <div className="mt-1 pharos-numeric text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}
