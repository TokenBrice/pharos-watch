import type { ReactNode } from "react";
import {
  formatMethodologyDisplayDate,
  toMethodologyVersionLabel,
  type MethodologyChangelogDetailBlock,
  type MethodologyChangelogEntry,
  type MethodologyChangelogRichText,
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
  columns: readonly ChangelogDataTableColumn[];
  rows: readonly ChangelogDataTableRow[];
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

function ChangelogRichText({ text }: { text: MethodologyChangelogRichText }) {
  const segments = typeof text === "string" ? [text] : text;
  return (
    <>
      {segments.map((segment, index) => {
        if (typeof segment === "string") return segment;
        if ("code" in segment) {
          return (
            <code key={index} className="text-xs bg-muted px-1 py-0.5 rounded">
              {segment.code}
            </code>
          );
        }
        if ("emphasis" in segment) {
          return (
            <span key={index} className="text-foreground font-medium">
              {segment.emphasis}
            </span>
          );
        }
        return (
          <span key={index} className="pharos-numeric">
            {segment.numeric}
          </span>
        );
      })}
    </>
  );
}

function ChangelogDetailBlocks({ blocks }: { blocks: readonly MethodologyChangelogDetailBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "paragraph":
            return (
              <p key={index}>
                <ChangelogRichText text={block.text} />
              </p>
            );
          case "list":
            return (
              <ul key={index} className="list-disc list-inside space-y-1">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>
                    <ChangelogRichText text={item} />
                  </li>
                ))}
              </ul>
            );
          case "formula":
            return (
              <div key={index} className="rounded-lg border p-3 pharos-numeric text-xs bg-muted">
                {block.text}
              </div>
            );
          case "weights":
            return <WeightRow key={index} values={block.values} />;
          case "table":
            return (
              <ChangelogDataTable
                key={index}
                ariaLabel={block.ariaLabel}
                tableId={block.tableId}
                testId={block.testId}
                columns={block.columns}
                rows={block.rows}
              />
            );
          case "section":
            return (
              <div key={index} className="space-y-2">
                <h3 className="text-foreground font-medium">{block.heading}</h3>
                <ChangelogDetailBlocks blocks={block.blocks} />
              </div>
            );
        }
      })}
    </>
  );
}

/**
 * Renders a changelog entry straight from its structured
 * `shared/data/methodology-changelogs/` record: the ordered `detail` body when
 * the published card carries headings, tables or formulas, and `summary` plus
 * `impact` otherwise.
 */
export function StructuredChangelogDetail({ entry }: { entry: MethodologyChangelogEntry }) {
  if (entry.detail) {
    return <ChangelogDetailBlocks blocks={entry.detail} />;
  }
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

function WeightRow({ values }: { values: readonly [string, string, string, string, string, string] }) {
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
