import type { ReactNode } from "react";
import {
  formatMethodologyDisplayDate,
  toMethodologyVersionLabel,
  type MethodologyChangelogEntry,
} from "@shared/lib/methodology-version";
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

export function ChangelogTable({
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

export function VersionCard({ entry, children }: { entry: MethodologyChangelogEntry; children: ReactNode }) {
  const versionLabel = toMethodologyVersionLabel(entry.version);
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
    <ChangelogTable>
      <TableHeader>
        <TableRow>
          {headers.map((h) => (
            <TableHead key={h} scope="col" className={changelogTableClassNames.numericHead}>
              {h}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          {values.map((v, i) => (
            <TableCell key={headers[i]} className={changelogTableClassNames.numericCell}>
              {v}
            </TableCell>
          ))}
        </TableRow>
      </TableBody>
    </ChangelogTable>
  );
}
