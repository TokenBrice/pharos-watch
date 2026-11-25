import Link from "next/link";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import { getMechanismArchetypeLabel, getMechanismExplainerPath } from "@shared/lib/classification";
import {
  MECHANISM_DEPENDENCY_COLUMNS,
  MECHANISM_DEPENDENCY_DOT,
  MECHANISM_MATRIX,
  MECHANISM_MATRIX_COLUMNS,
} from "@/lib/mechanism-matrix";
import { cn } from "@/lib/utils";
import {
  TableBody,
  TableCaption,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { SectionHeading, SectionKicker } from "../_shared/section-primitives";

export function MechanismDependencyValue({ value }: { value: string }) {
  const dot = MECHANISM_DEPENDENCY_DOT[value];
  if (!dot) {
    return <span className="text-muted-foreground">{value}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)}
      />
      <span className="text-foreground/85">{value}</span>
    </span>
  );
}

export function MechanismComparisonMatrix() {
  return (
    <section aria-labelledby="mechanism-matrix-heading" className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <SectionKicker>Side-by-side</SectionKicker>
          <SectionHeading id="mechanism-matrix-heading">
            Types of stablecoins
          </SectionHeading>
        </div>
        <span className="text-xs tabular-nums text-muted-foreground">
          {MECHANISM_ARCHETYPE_VALUES.length} mechanisms
        </span>
      </div>
      <TableFrame
        tableId="mechanism-comparison-matrix"
        testId="mechanism-comparison-matrix-table"
        chrome="default"
        density="compact"
        striped
        tableClassName="w-full min-w-[54rem] table-fixed border-collapse text-left text-xs"
        tableProps={{ "aria-label": "Stablecoin mechanism comparison matrix" }}
        viewportProps={{
          compactBottomPadding: false,
          mobileScrollHint: "Swipe sideways to compare mechanisms",
        }}
      >
        <TableCaption className="sr-only">Stablecoin mechanism comparison matrix</TableCaption>
        <colgroup>
          <col className="w-[19%]" />
          <col className="w-[13%]" />
          <col className="w-[11%]" />
          <col className="w-[11%]" />
          <col className="w-[14%]" />
          <col className="w-[10%]" />
          <col className="w-[12%]" />
          <col className="w-[10%]" />
        </colgroup>
        <TableHeader>
          <TableRow className="border-b border-border/60 bg-muted/30">
            <TableHead
              scope="col"
              className="pharos-table-sticky-metric z-10 h-auto whitespace-normal border-r border-border/50 px-3 py-2.5 align-bottom font-semibold text-foreground"
            >
              Mechanism
            </TableHead>
            {MECHANISM_MATRIX_COLUMNS.map((col) => (
              <TableHead
                key={col.key}
                scope="col"
                className="h-auto whitespace-normal px-3 py-2.5 align-bottom font-semibold text-muted-foreground"
              >
                <span className="sr-only">{col.label}</span>
                <span aria-hidden="true" className="hidden md:inline">{col.label}</span>
                <span aria-hidden="true" className="md:hidden">{col.short}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {MECHANISM_ARCHETYPE_VALUES.map((archetype) => {
            const row = MECHANISM_MATRIX[archetype];
            return (
              <TableRow
                key={archetype}
                rowIntent="scan"
                className="border-b border-border/40 last:border-b-0"
              >
                <TableHead
                  scope="row"
                  className="pharos-table-sticky-metric h-auto whitespace-normal border-r border-border/50 px-3 py-2.5 align-top text-left font-medium text-foreground"
                >
                  <Link
                    href={getMechanismExplainerPath(archetype)}
                    className="pharos-focus-ring rounded-sm underline-offset-4 hover:text-brand-accent-text hover:underline"
                  >
                    {getMechanismArchetypeLabel(archetype)}
                  </Link>
                </TableHead>
                {MECHANISM_MATRIX_COLUMNS.map((col) => (
                  <TableCell
                    key={col.key}
                    className="whitespace-normal px-3 py-2.5 align-top text-muted-foreground"
                  >
                    {MECHANISM_DEPENDENCY_COLUMNS.has(col.key) ? (
                      <MechanismDependencyValue value={row[col.key]} />
                    ) : (
                      row[col.key]
                    )}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </TableFrame>
    </section>
  );
}
