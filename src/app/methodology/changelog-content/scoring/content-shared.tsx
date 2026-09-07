import type { ReactNode } from "react";
import {
  formatMethodologyDisplayDate,
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "@shared/lib/methodology-versions/base";
import { slugifyId } from "@shared/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";

export function scoringAnchorId(version: string) {
  return `scoring-${slugifyId(version)}`;
}

function Pill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-full bg-muted px-2 py-0.5 text-xs pharos-numeric font-medium text-foreground">
      {children}
    </span>
  );
}

export const changelogTableClassNames = {
  head: "h-auto whitespace-normal px-0 py-2 pr-4 text-left font-medium text-foreground last:pr-0",
  cell: "whitespace-normal px-0 py-2 pr-4 align-top last:pr-0",
  rowHeader: "whitespace-normal px-0 py-2 pr-4 align-top font-medium text-foreground last:pr-0",
  numericHead: "h-auto whitespace-normal px-0 py-2 pr-4 text-right font-medium text-foreground last:pr-0",
  numericCell: "pharos-numeric whitespace-normal px-0 py-2 pr-4 text-right align-top last:pr-0",
};

function ChangelogTable({
  ariaLabel,
  children,
  tableId,
  testId,
}: {
  ariaLabel?: string;
  children: ReactNode;
  tableId?: string;
  testId?: string;
}) {
  return (
    <TableFrame
      chrome="content"
      density="compact"
      tableId={tableId}
      testId={testId}
      viewportProps={{ mobileScrollHint: false }}
      tableProps={ariaLabel ? { "aria-label": ariaLabel } : undefined}
    >
      {children}
    </TableFrame>
  );
}

type ChangelogDataTableColumn = {
  id: string; label: ReactNode; headClassName?: string; cellClassName?: string; rowHeader?: boolean;
};
type ChangelogDataTableRow = { id: string; cells: Record<string, ReactNode> };

export function ChangelogDataTable({
  columns,
  rows,
  ...tableProps
}: {
  columns: ChangelogDataTableColumn[];
  rows: ChangelogDataTableRow[];
  ariaLabel?: string;
  tableId?: string;
  testId?: string;
}) {
  return (
    <ChangelogTable {...tableProps}>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column.id} scope="col" className={column.headClassName ?? changelogTableClassNames.head}>
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.id}>
            {columns.map((column) => (
              <TableCell key={column.id} className={column.cellClassName ?? (column.rowHeader
                ? changelogTableClassNames.rowHeader
                : changelogTableClassNames.cell)}>
                {row.cells[column.id]}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </ChangelogTable>
  );
}

/**
 * Renders a changelog entry straight from its structured
 * `shared/data/methodology-changelogs/` record. Every V9-era entry uses this;
 * only pre-V9 versions still carry hand-authored prose (they predate the
 * structured `summary`/`impact` fields carrying the whole story).
 */
export function StructuredChangelogDetail({ entry }: { entry: MethodologyChangelogEntry }) {
  return (
    <>
      <p>{entry.summary}</p>
      <ul className="list-disc list-inside space-y-1">
        {entry.impact.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

export function VersionCard({
  entry,
  children,
  versionLabel = toMethodologyVersionLabel(entry.version),
}: {
  entry: MethodologyChangelogEntry;
  children: ReactNode;
  versionLabel?: string;
}) {
  const anchorId = scoringAnchorId(versionLabel);

  return (
    <Card id={anchorId} className="scroll-mt-28 rounded-xl">
      <CardHeader>
        <CardTitle as="h2">
          <span className="flex flex-wrap items-center gap-2">
            <Pill>{versionLabel}</Pill>
            {entry.title}
            <span className="text-sm font-normal text-muted-foreground">
              {formatMethodologyDisplayDate(entry.date)}
            </span>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm text-muted-foreground leading-relaxed">{children}</CardContent>
    </Card>
  );
}

export function WeightRow({ values }: { values: [string, string, string, string, string, string] }) {
  const headers = ["Peg", "Liquidity", "Safety", "Resilience", "Decentralization", "Dep Risk"];
  return (
    <ChangelogDataTable
      columns={headers.map((header) => ({
        id: header,
        label: header,
        headClassName: changelogTableClassNames.numericHead,
        cellClassName: changelogTableClassNames.numericCell,
      }))}
      rows={[{ id: "weights", cells: Object.fromEntries(headers.map((header, index) => [header, values[index]])) }]}
    />
  );
}
