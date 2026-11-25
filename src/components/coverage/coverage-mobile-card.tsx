import {
  DISCLOSURE_SUMMARY_RESET_CLASS,
  DisclosureChevron,
} from "@/components/disclosure-panel";
import {
  type CoverageFeatureDefinition,
  type CoverageFeatureKey,
  type CoverageRow,
  COVERAGE_FEATURES,
} from "@/lib/coverage";
import { MOBILE_PREVIEW_FEATURES } from "@/lib/coverage-page-config";
import { cn } from "@/lib/utils";
import { CoverageBadge } from "@/components/coverage/coverage-badge";
import { CoverageCoinIdentity } from "@/components/coverage/coverage-coin-identity";

const REMAINING_MOBILE_FEATURES = COVERAGE_FEATURES.filter((feature) => !MOBILE_PREVIEW_FEATURES.includes(feature.key));
const COVERAGE_FEATURES_BY_KEY = Object.fromEntries(
  COVERAGE_FEATURES.map((feature) => [feature.key, feature]),
) as Record<CoverageFeatureKey, CoverageFeatureDefinition>;
const MOBILE_PREVIEW_DEFINITIONS = MOBILE_PREVIEW_FEATURES.map((key) => COVERAGE_FEATURES_BY_KEY[key]);

export interface CoverageMobileCardProps {
  row: CoverageRow;
  logoSrc?: string;
}

function CoverageFeatureStatusRow({
  feature,
  status,
}: {
  feature: CoverageFeatureDefinition;
  status: CoverageRow["statuses"][CoverageFeatureKey];
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/50 py-1.5">
      <dt className="min-w-0 truncate text-2xs font-medium text-muted-foreground">{feature.shortLabel}</dt>
      <dd className="shrink-0">
        <CoverageBadge status={status} compact />
      </dd>
    </div>
  );
}

export function CoverageMobileCard({ row, logoSrc }: CoverageMobileCardProps) {
  return (
    <article className="pharos-card-shell overflow-hidden">
      <div className="space-y-3 px-4 pt-3.5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <CoverageCoinIdentity row={row} logoSrc={logoSrc} logoSize={32} linked variant="mobile" />

          <div className="shrink-0 text-right">
            <div className="pharos-label">Available</div>
            <div className="pharos-numeric text-base font-semibold leading-tight text-foreground">
              {row.coverageCount}/{COVERAGE_FEATURES.length}
            </div>
            <div className="mt-0.5 text-3xs font-medium text-muted-foreground">
              Headline{" "}
              <span className="pharos-numeric">
                {row.headlineCoverageCount}/{COVERAGE_FEATURES.length}
              </span>
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {MOBILE_PREVIEW_DEFINITIONS.map((feature) => (
            <CoverageFeatureStatusRow
              key={feature.key}
              feature={feature}
              status={row.statuses[feature.key]}
            />
          ))}
        </dl>
      </div>

      <details className="group/disclosure border-t border-border/55">
        <summary
          className={cn(
            DISCLOSURE_SUMMARY_RESET_CLASS,
            "flex min-h-11 items-center justify-between gap-2 px-4 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground",
          )}
        >
          <span>More features ({REMAINING_MOBILE_FEATURES.length})</span>
          <DisclosureChevron />
        </summary>

        <div className="border-t border-border/50 px-4 py-3">
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            {REMAINING_MOBILE_FEATURES.map((feature) => (
              <CoverageFeatureStatusRow
                key={feature.key}
                feature={feature}
                status={row.statuses[feature.key]}
              />
            ))}
          </dl>
        </div>
      </details>
    </article>
  );
}
