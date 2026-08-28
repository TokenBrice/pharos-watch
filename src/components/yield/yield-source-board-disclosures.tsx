"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { formatYieldWarningSignal } from "@/lib/yield-constants";
import { YIELD_TYPE_STYLES } from "@shared/lib/classification";
import type {
  YieldSourceBoardAnomalyDetail,
  YieldSourceBoardRowDetail,
  YieldSourceBoardSourceSwitchDetail,
} from "@/lib/yield-source-board-model";

function DisclosureRowFrame({ detail, children }: { detail: YieldSourceBoardRowDetail; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-1 py-2 sm:flex-row sm:items-baseline sm:gap-3">
      <div className="flex shrink-0 items-center gap-2 sm:w-56">
        <Badge variant="outline" className={cn("text-[11px]", YIELD_TYPE_STYLES[detail.yieldType]?.badge ?? "")}>
          {detail.yieldTypeLabel}
        </Badge>
        <Link
          href={buildStablecoinUrl(detail.id, "yield/")}
          className="pharos-focus-ring rounded-sm text-sm font-medium text-foreground underline-offset-4 hover:underline"
        >
          {detail.symbol}
        </Link>
        <span className="text-xs text-muted-foreground">{detail.dataSourceLabel}</span>
      </div>
      <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">{children}</p>
    </li>
  );
}

function SourceDetailList<T extends YieldSourceBoardRowDetail>({
  details,
  emptyLabel,
  keyPrefix,
  renderDetail,
}: {
  details: readonly T[];
  emptyLabel: string;
  keyPrefix: string;
  renderDetail: (detail: T) => ReactNode;
}) {
  if (details.length === 0) return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  return (
    <ul className="divide-y divide-border/40">
      {details.map((detail) => (
        <DisclosureRowFrame key={`${keyPrefix}-${detail.id}`} detail={detail}>
          {renderDetail(detail)}
        </DisclosureRowFrame>
      ))}
    </ul>
  );
}

export function SourceSwitchDisclosure({ details }: { details: YieldSourceBoardSourceSwitchDetail[] }) {
  return (
    <SourceDetailList
      details={details}
      emptyLabel="No source-switch detail captured for this view."
      keyPrefix="switch"
      renderDetail={(detail) => detail.previousSourceKey
        ? <>was <span className="font-mono">{detail.previousSourceKey}</span> · now <span className="font-mono">{detail.currentYieldSource}</span></>
        : <>now <span className="font-mono">{detail.currentYieldSource}</span></>}
    />
  );
}

export function AnomalyDisclosure({ details }: { details: YieldSourceBoardAnomalyDetail[] }) {
  return (
    <SourceDetailList
      details={details}
      emptyLabel="No anomaly detail captured for this view."
      keyPrefix="anomaly"
      renderDetail={(detail) => detail.anomalies.map(formatYieldWarningSignal).join(" · ")}
    />
  );
}
