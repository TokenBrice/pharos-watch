import Link from "next/link";
import { ChevronDown } from "lucide-react";
import {
  type CoverageFeatureDefinition,
  type CoverageFeatureKey,
  type CoverageRow,
  COVERAGE_FEATURES,
} from "@/lib/coverage";
import { MOBILE_PREVIEW_FEATURES } from "@/lib/coverage-page-config";
import { buildStablecoinUrl } from "@shared/lib/urls";
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
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-background/45 px-3 py-2">
      <dt className="min-w-0 text-[11px] font-medium text-muted-foreground">{feature.shortLabel}</dt>
      <dd className="shrink-0">
        <CoverageBadge status={status} compact />
      </dd>
    </div>
  );
}

export function CoverageMobileCard({ row, logoSrc }: CoverageMobileCardProps) {
  return (
    <details className="group rounded-xl border border-border/70 bg-background/35 open:bg-background/42">
      <summary className="pharos-focus-ring flex cursor-pointer list-none flex-col gap-4 p-4 [&::-webkit-details-marker]:hidden">
        <div className="flex items-start justify-between gap-3">
          <CoverageCoinIdentity row={row} logoSrc={logoSrc} logoSize={32} variant="mobile" />

          <div className="shrink-0 text-right">
            <div className="pharos-kicker">Available</div>
            <div className="pharos-numeric text-lg font-semibold text-foreground">
              {row.coverageCount}/{COVERAGE_FEATURES.length}
            </div>
            <div className="mt-0.5 text-[10px] font-medium text-muted-foreground">
              Headline {row.headlineCoverageCount}/{COVERAGE_FEATURES.length}
            </div>
            <ChevronDown
              className="ml-auto mt-2 h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </div>
        </div>

        <dl className="grid gap-2 sm:grid-cols-2">
          {MOBILE_PREVIEW_DEFINITIONS.map((feature) => (
            <CoverageFeatureStatusRow
              key={feature.key}
              feature={feature}
              status={row.statuses[feature.key]}
            />
          ))}
        </dl>
      </summary>

      <div className="space-y-4 border-t border-border/60 px-4 py-4">
        <dl className="grid gap-2">
          {REMAINING_MOBILE_FEATURES.map((feature) => (
            <CoverageFeatureStatusRow
              key={feature.key}
              feature={feature}
              status={row.statuses[feature.key]}
            />
          ))}
        </dl>

        <Link
          href={buildStablecoinUrl(row.id)}
          className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background/55 px-4 py-2 text-sm font-medium text-foreground hover:border-foreground/20 hover:bg-accent"
        >
          Open stablecoin detail
        </Link>
      </div>
    </details>
  );
}
