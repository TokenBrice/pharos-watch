"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  TableFrame,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { cn } from "@/lib/utils";
import { groupComplianceRowsIntoBands, type ComplianceRow } from "@/lib/compliance-model";
import {
  GeniusAuthorityCell,
  GeniusPathwayCell,
  GeniusReserveCell,
  GeniusReviewDetails,
  GeniusStatusCell,
} from "./genius-compliance-cells";
import {
  MicaAuthorityCell,
  MicaPathwayCell,
  MicaStatusCell,
} from "./mica-compliance-cells";
import {
  CoinLink,
  ComplianceStatusBadge,
  EmptyCell,
  SourceLinks,
} from "./compliance-row-primitives";

const COMPLIANCE_TEXT_CELL_CLASS = "whitespace-normal break-words align-top leading-snug";

export function ComplianceTable({
  rows,
  regime,
  logos,
  tableId,
  testId,
  ariaLabel,
  forceCollapsedBandsOpen,
}: {
  rows: ComplianceRow[];
  regime: "mica" | "genius";
  logos: Record<string, string> | undefined;
  tableId: string;
  testId: string;
  ariaLabel: string;
  forceCollapsedBandsOpen: boolean;
}) {
  const bands = groupComplianceRowsIntoBands(rows, regime);
  const [expandedBands, setExpandedBands] = useState<Record<string, boolean>>({});

  return (
    <TableFrame
      tableId={tableId}
      testId={testId}
      chrome="bare"
      className="pharos-table-shell"
      tableClassName="table-fixed min-w-[860px]"
      tableProps={{ "aria-label": ariaLabel }}
      viewportClassName="relative w-full"
      viewportProps={{ compactBottomPadding: false }}
    >
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[180px]">Coin</TableHead>
          <TableHead className="w-[140px]">Status</TableHead>
          <TableHead className="w-[165px]">Pathway / Type</TableHead>
          <TableHead className="w-[150px]">Authority</TableHead>
          <TableHead>Issuer Entity</TableHead>
          <TableHead className="w-12"><span className="sr-only">Details</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {bands.map((band) => {
          const canCollapse = band.collapsedByDefault && !forceCollapsedBandsOpen;
          const isExpanded = canCollapse ? (expandedBands[band.status] ?? false) : true;
          return (
            <ComplianceBand
              key={band.status}
              band={band}
              logos={logos}
              tableId={tableId}
              canCollapse={canCollapse}
              isExpanded={isExpanded}
              onToggle={() => {
                setExpandedBands((current) => ({ ...current, [band.status]: !isExpanded }));
              }}
            />
          );
        })}
      </TableBody>
    </TableFrame>
  );
}

function ComplianceBand({
  band,
  logos,
  tableId,
  canCollapse,
  isExpanded,
  onToggle,
}: {
  band: ReturnType<typeof groupComplianceRowsIntoBands>[number];
  logos: Record<string, string> | undefined;
  tableId: string;
  canCollapse: boolean;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const countLabel = `${band.rows.length.toLocaleString()} ${band.rows.length === 1 ? "stablecoin" : "stablecoins"}`;

  return (
    <>
      <TableRow rowIntent="static" className="bg-muted/25 hover:bg-muted/25">
        <TableCell colSpan={6} className="p-0">
          {canCollapse ? (
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={onToggle}
              className="pharos-focus-ring flex min-h-11 w-full items-center justify-between gap-3 rounded-sm px-3 py-2 text-left text-sm font-medium text-foreground"
            >
              <span>
                {band.label} <span className="font-normal text-muted-foreground">— {countLabel}, {isExpanded ? "collapse" : "expand"}</span>
              </span>
              <ChevronDown
                className={cn("h-4 w-4 shrink-0 transition-transform", isExpanded && "rotate-180")}
                aria-hidden="true"
              />
            </button>
          ) : (
            <div className="flex min-h-11 items-center gap-2 px-3 py-2">
              <ComplianceStatusBadge regime={band.rows[0].regime} status={band.status} />
              <span className="pharos-numeric text-xs text-muted-foreground">{countLabel}</span>
            </div>
          )}
        </TableCell>
      </TableRow>
      {isExpanded
        ? band.rows.map((row) => (
            <ComplianceTableRow key={`${row.regime}:${row.id}`} row={row} logo={logos?.[row.id]} tableId={tableId} />
          ))
        : null}
    </>
  );
}

function ComplianceTableRow({
  row,
  logo,
  tableId,
}: {
  row: ComplianceRow;
  logo: string | undefined;
  tableId: string;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasExtraDetail = hasComplianceRowDetails(row);
  const detailId = `${tableId}-${row.regime}-${row.id}-details`;

  return (
    <>
      <TableRow>
        <TableCell>
          <CoinLink row={row} logo={logo} />
        </TableCell>
        <TableCell>{row.regime === "mica" ? <MicaStatusCell row={row} /> : <GeniusStatusCell row={row} />}</TableCell>
        <TableCell className={COMPLIANCE_TEXT_CELL_CLASS}>
          {row.regime === "mica" ? <MicaPathwayCell row={row} /> : <GeniusPathwayCell row={row} />}
        </TableCell>
        <TableCell className={COMPLIANCE_TEXT_CELL_CLASS}>
          {row.regime === "mica" ? <MicaAuthorityCell row={row} /> : <GeniusAuthorityCell row={row} />}
        </TableCell>
        <TableCell className={COMPLIANCE_TEXT_CELL_CLASS}>
          {row.regime === "mica" ? (
            row.authorizedEntity ? <span className="text-sm">{row.authorizedEntity}</span> : <EmptyCell />
          ) : row.issuerEntity ? (
            <span className="text-sm">
              {row.issuerEntity}
              {row.issuerDomicile ? <span className="block text-xs text-muted-foreground">{row.issuerDomicile}</span> : null}
            </span>
          ) : (
            <EmptyCell />
          )}
        </TableCell>
        <TableCell className="px-1 text-right">
          {hasExtraDetail ? (
            <button
              type="button"
              aria-expanded={isExpanded}
              aria-controls={detailId}
              aria-label={`${isExpanded ? "Collapse" : "Expand"} details for ${row.symbol}`}
              onClick={() => setIsExpanded((open) => !open)}
              className="pharos-focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground md:min-h-8 md:min-w-8"
            >
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", isExpanded && "rotate-180")}
                aria-hidden="true"
              />
            </button>
          ) : null}
        </TableCell>
      </TableRow>
      {hasExtraDetail && isExpanded ? (
        <TableRow id={detailId} rowIntent="static" className="bg-muted/15 hover:bg-muted/15">
          <TableCell colSpan={6} className="whitespace-normal px-4 py-4">
            <ComplianceRowDetails row={row} />
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function hasGeniusReviewDetails(row: Extract<ComplianceRow, { regime: "genius" }>): boolean {
  return Boolean(
    row.notes ||
      row.applicabilitySummary ||
      row.foreignExceptionSummary ||
      row.negativeEvidenceSummary ||
      row.negativeEvidenceSourcesChecked.length > 0 ||
      row.reviewer ||
      row.reviewedAt,
  );
}

function hasComplianceRowDetails(row: ComplianceRow): boolean {
  if (row.references.length > 0) return true;
  return row.regime === "genius" && (row.hasAnyDisclosure || hasGeniusReviewDetails(row));
}

function ComplianceRowDetails({ row }: { row: ComplianceRow }) {
  const hasReviewDetails = row.regime === "genius" && hasGeniusReviewDetails(row);
  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
      {row.references.length > 0 ? (
        <div className="min-w-0 space-y-2">
          <p className="pharos-kicker">Sources</p>
          <SourceLinks references={row.references} />
        </div>
      ) : null}
      {hasReviewDetails ? <GeniusReviewDetails row={row} /> : null}
      {row.regime === "genius" && row.hasAnyDisclosure ? (
        <div className="min-w-0 space-y-2">
          <p className="pharos-kicker">Reserve Disclosure</p>
          <GeniusReserveCell row={row} />
        </div>
      ) : null}
    </div>
  );
}
