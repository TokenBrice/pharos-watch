import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  MICA_AUTHORIZATION_TYPE_LABELS,
  MICA_SIGNIFICANT_BADGE_CLS,
  MICA_TOKEN_TYPE_BADGE_STYLES,
  MICA_TOKEN_TYPE_LABELS,
} from "@shared/lib/mica";
import type { ComplianceRow } from "@/lib/compliance-model";
import { ComplianceStatusBadge, EmptyCell } from "./compliance-row-primitives";

export function MicaStatusCell({ row }: { row: Extract<ComplianceRow, { regime: "mica" }> }) {
  return <ComplianceStatusBadge regime="mica" status={row.status} />;
}

export function MicaPathwayCell({ row }: { row: Extract<ComplianceRow, { regime: "mica" }> }) {
  const tokenType = row.tokenType ? MICA_TOKEN_TYPE_BADGE_STYLES[row.tokenType] : null;
  return (
    <div className="space-y-1">
      {tokenType ? (
        <span
          title={MICA_TOKEN_TYPE_LABELS[row.tokenType!]}
          className={cn(
            "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold",
            tokenType.cls,
          )}
        >
          {tokenType.label}
        </span>
      ) : (
        <EmptyCell />
      )}
      {row.authorizationType ? (
        <span className="block text-xs text-muted-foreground">
          {MICA_AUTHORIZATION_TYPE_LABELS[row.authorizationType]}
        </span>
      ) : null}
      {row.significant ? (
        <span
          title="EBA-supervised significant EMT/ART"
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold",
            MICA_SIGNIFICANT_BADGE_CLS,
          )}
        >
          <Check className="h-3 w-3" aria-hidden="true" />
          Significant
        </span>
      ) : null}
    </div>
  );
}

export function MicaAuthorityCell({ row }: { row: Extract<ComplianceRow, { regime: "mica" }> }) {
  return row.competentAuthority ? <span className="text-sm">{row.competentAuthority}</span> : <EmptyCell />;
}
