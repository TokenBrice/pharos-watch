import { memo, type MouseEvent } from "react";
import Image from "next/image";
import { ChevronDown } from "lucide-react";
import { MECHANISM_ARCHETYPE_SHORT_LABELS } from "@shared/lib/classification";
import { TableCell, TableRow } from "@/components/table";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import { cn } from "@/lib/utils";
import { CemeteryRegisterAutopsy } from "./cemetery-register-autopsy";
import { CemeteryRegisterCauseDot } from "./cemetery-register-cause-dot";
import { REGISTER_SCROLL_MARGIN_CLASS } from "./cemetery-register-model";

const TAG_CLASS =
  "inline-flex items-center rounded border border-border/70 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground";

const NOT_RECORDED = (
  <>
    <span aria-hidden="true">—</span>
    <span className="sr-only">not recorded</span>
  </>
);

export interface CemeteryRegisterRowPairProps {
  row: CemeteryRegisterRow;
  /** Beyond the first 25 while unfiltered and not shown in full; CSS hides it unless it is the `:target`. */
  folded: boolean;
  expanded: boolean;
  highlightClassName: string | undefined;
  columnCount: number;
  onToggle: (id: string, open: boolean) => void;
  onShowOnField: (id: string) => void;
}

/** The record's main row (`id="<id>"`, the canonical public anchor) and its autopsy row. */
export const CemeteryRegisterRowPair = memo(function CemeteryRegisterRowPair({
  row,
  folded,
  expanded,
  highlightClassName,
  columnCount,
  onToggle,
  onShowOnField,
}: CemeteryRegisterRowPairProps) {
  const autopsyId = `autopsy-${row.id}`;

  // Whole-row tap toggles; the disclosure button stays the keyboard path, and
  // nested controls or a text selection keep their own behaviour.
  const handleRowClick = (event: MouseEvent<HTMLTableRowElement>) => {
    if ((event.target as Element).closest("a, button, input, select, label")) return;
    if (window.getSelection()?.toString()) return;
    onToggle(row.id, !expanded);
  };

  return (
    <>
      <TableRow
        id={row.id}
        data-folded={folded ? "" : undefined}
        onClick={handleRowClick}
        // "static" drops the shared hover accent (brand frost), which never appears below the cemetery hero;
        // the primitive's neutral hover background remains.
        rowIntent="static"
        className={cn(
          "cursor-pointer",
          REGISTER_SCROLL_MARGIN_CLASS,
          expanded && "border-b-0 bg-muted/30 hover:bg-muted/30",
          highlightClassName,
        )}
      >
        <TableCell className="w-full max-w-0 px-2 py-2.5 sm:px-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {/* Below `sm` the logo yields its width to the name, which tells the duplicate tickers apart. */}
            {row.logoUrl ? (
              <Image
                src={row.logoUrl}
                alt=""
                width={20}
                height={20}
                unoptimized
                className="hidden h-5 w-5 shrink-0 rounded-full grayscale sm:block"
              />
            ) : (
              <span
                aria-hidden="true"
                className="hidden h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground sm:flex"
              >
                {row.symbol.charAt(0)}
              </span>
            )}
            <div className="min-w-0">
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 font-semibold text-foreground line-through decoration-muted-foreground/80">
                  {row.symbol}
                </span>
                <span className="truncate text-muted-foreground">{row.name}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground md:hidden">
                <CemeteryRegisterCauseDot cause={row.cause} />
                <span className="min-w-0 truncate">{row.causeLabel}</span>
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden md:table-cell">
          <span className="inline-flex items-center gap-1.5">
            <CemeteryRegisterCauseDot cause={row.cause} />
            {row.causeLabel}
          </span>
        </TableCell>
        <TableCell className="pharos-numeric px-2 text-xs sm:px-3 sm:text-sm">{row.deathDateLabel}</TableCell>
        <TableCell className="pharos-numeric px-2 text-right text-xs sm:px-3 sm:text-sm">
          {row.peakLabel ?? NOT_RECORDED}
        </TableCell>
        <TableCell className="pharos-numeric hidden text-xs md:table-cell">{row.pegCurrency}</TableCell>
        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
          {row.mechanismArchetype ? MECHANISM_ARCHETYPE_SHORT_LABELS[row.mechanismArchetype] : NOT_RECORDED}
        </TableCell>
        <TableCell className="hidden lg:table-cell">
          <span className="flex gap-1">
            {row.tracked ? (
              <span className={TAG_CLASS} title="Pharos tracked this coin; its frozen detail page is online">
                Archive
              </span>
            ) : (
              <span className="sr-only">Curated record</span>
            )}
            {row.caseStudy ? <span className={TAG_CLASS}>Case study</span> : null}
          </span>
        </TableCell>
        <TableCell className="hidden xl:table-cell">
          {row.epitaph ? (
            <span className="block max-w-[14rem] truncate italic text-muted-foreground 2xl:max-w-[20rem]" title={row.epitaph}>
              {row.epitaph}
            </span>
          ) : (
            NOT_RECORDED
          )}
        </TableCell>
        <TableCell className="px-1 text-right">
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={autopsyId}
            aria-label={`${expanded ? "Close" : "Open"} autopsy for ${row.name} (${row.symbol})`}
            onClick={() => onToggle(row.id, !expanded)}
            className="pharos-focus-ring inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground md:min-h-8 md:min-w-8"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn("h-4 w-4 motion-safe:transition-transform", expanded && "rotate-180")}
            />
          </button>
        </TableCell>
      </TableRow>
      <TableRow
        id={autopsyId}
        data-detail=""
        hidden={!expanded}
        rowIntent="static"
        className="bg-muted/30 hover:bg-muted/30"
      >
        <TableCell colSpan={columnCount} className="whitespace-normal p-0">
          <CemeteryRegisterAutopsy row={row} expanded={expanded} onShowOnField={onShowOnField} />
        </TableCell>
      </TableRow>
    </>
  );
});
