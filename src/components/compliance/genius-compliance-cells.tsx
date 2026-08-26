import {
  GENIUS_APPLICABILITY_LABELS,
  GENIUS_DASP_OFFER_SALE_STATUS_LABELS,
  GENIUS_ENFORCEMENT_STATUS_LABELS,
  GENIUS_FOREIGN_EXCEPTION_STATUS_LABELS,
  GENIUS_ISSUER_PATHWAY_LABELS,
} from "@shared/lib/genius";
import type { ComplianceRow } from "@/lib/compliance-model";
import { ComplianceStatusBadge, EmptyCell } from "./compliance-row-primitives";

type GeniusComplianceRow = Extract<ComplianceRow, { regime: "genius" }>;

export function GeniusStatusCell({ row }: { row: GeniusComplianceRow }) {
  return (
    <div className="space-y-1">
      <ComplianceStatusBadge regime="genius" status={row.status} />
      {row.enforcementStatus ? (
        <span className="block text-xs text-muted-foreground">
          Enforcement: {GENIUS_ENFORCEMENT_STATUS_LABELS[row.enforcementStatus]}
        </span>
      ) : null}
      {row.daspOfferSaleStatus ? (
        <span className="block text-xs text-muted-foreground">
          DASP: {GENIUS_DASP_OFFER_SALE_STATUS_LABELS[row.daspOfferSaleStatus]}
        </span>
      ) : null}
    </div>
  );
}

export function GeniusPathwayCell({ row }: { row: GeniusComplianceRow }) {
  return (
    <span className="text-sm">
      {GENIUS_ISSUER_PATHWAY_LABELS[row.issuerPathway]}
      <span className="block text-xs text-muted-foreground">{GENIUS_APPLICABILITY_LABELS[row.applicability]}</span>
      {row.foreignExceptionStatus ? (
        <span className="block text-xs text-muted-foreground">
          Foreign exception: {GENIUS_FOREIGN_EXCEPTION_STATUS_LABELS[row.foreignExceptionStatus]}
        </span>
      ) : null}
    </span>
  );
}

export function GeniusAuthorityCell({ row }: { row: GeniusComplianceRow }) {
  const authority = row.primaryFederalRegulator ?? row.stateRegulator ?? row.licensingRegulator;
  const secondaryAuthority = row.licensingRegulator && row.licensingRegulator !== authority
    ? row.licensingRegulator
    : row.stateRegulator && row.stateRegulator !== authority
      ? row.stateRegulator
      : undefined;

  return authority ? (
    <span className="text-sm">
      {authority}
      {secondaryAuthority ? <span className="block text-xs text-muted-foreground">{secondaryAuthority}</span> : null}
    </span>
  ) : (
    <EmptyCell />
  );
}

export function GeniusReserveCell({ row }: { row: GeniusComplianceRow }) {
  if (!row.hasAnyDisclosure) return <EmptyCell />;
  const content = (
    <>
      {row.reserveDisclosurePresent ? "Reserve disclosure" : "Disclosure"}
      {row.latestReportDate ? <span className="block text-xs text-muted-foreground">{row.latestReportDate}</span> : null}
      {row.redemptionPolicyPresent ? <span className="block text-xs text-muted-foreground">Redemption policy</span> : null}
      {row.monthlyAttestationPresent ? (
        <span className="block text-xs text-muted-foreground">Monthly attestation</span>
      ) : null}
    </>
  );
  if (!row.reserveDisclosureUrl) return <span className="text-sm">{content}</span>;
  return (
    <a
      href={row.reserveDisclosureUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="pharos-focus-ring inline-flex flex-col rounded-sm text-sm text-frost-blue hover:underline"
    >
      {content}
    </a>
  );
}

export function GeniusReviewDetails({ row }: { row: GeniusComplianceRow }) {
  return (
    <div className="min-w-0 space-y-2 text-xs text-muted-foreground">
      <p className="pharos-kicker">Review Details</p>
      {row.reviewedAt || row.reviewer ? (
        <p>
          Reviewed{row.reviewedAt ? ` ${row.reviewedAt}` : ""}
          {row.reviewer ? ` by ${row.reviewer}` : ""}
        </p>
      ) : null}
      {row.applicabilitySummary ? <p>{row.applicabilitySummary}</p> : null}
      {row.foreignExceptionSummary ? <p>{row.foreignExceptionSummary}</p> : null}
      {row.negativeEvidenceSummary ? <p>{row.negativeEvidenceSummary}</p> : null}
      {row.notes ? <p>{row.notes}</p> : null}
      {row.negativeEvidenceSourcesChecked.length > 0 ? (
        <div className="space-y-1">
          <p className="font-medium text-foreground">Sources checked</p>
          <ul className="list-inside list-disc space-y-0.5">
            {row.negativeEvidenceSourcesChecked.slice(0, 5).map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
