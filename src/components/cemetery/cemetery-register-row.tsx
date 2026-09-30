import { memo, type MouseEvent } from "react";
import { CAUSE_META } from "@shared/lib/cause-of-death";
import { MECHANISM_ARCHETYPE_SHORT_LABELS } from "@shared/lib/classification";
import { TableCell, TableRow } from "@/components/table";
import { causeColorVars } from "@/lib/cemetery-cause-style";
import type { CemeteryRegisterRow } from "@/lib/cemetery-register";
import { formatCemeteryPeak } from "@/lib/cemetery-stats";
import { cn } from "@/lib/utils";
import { CemeteryRegisterAutopsy } from "./cemetery-register-autopsy";
import { formatRegisterDeathDate } from "./cemetery-register-model";
import styles from "./cemetery-register.module.css";

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
  const causeLabel = CAUSE_META[row.cause].label;

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
        // The cause marks in this row read their colour from these custom properties.
        style={causeColorVars(row.cause)}
        className={cn("cursor-pointer", expanded && "border-b-0 bg-muted/30 hover:bg-muted/30", highlightClassName)}
      >
        <TableCell className="w-full max-w-0 px-2 py-2.5 sm:px-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {row.logoUrl ? (
              // A plain image: the static export serves logos unoptimised, so next/image adds only markup.
              <img src={row.logoUrl} alt="" width={20} height={20} loading="lazy" decoding="async" className={styles.logo} />
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
                <span className={styles.symbol}>{row.symbol}</span>
                <span className="truncate text-muted-foreground">{row.name}</span>
              </div>
              <div className={styles.mobileCause}>
                <span aria-hidden="true" className={styles.dot} />
                <span className="min-w-0 truncate">{causeLabel}</span>
              </div>
            </div>
          </div>
        </TableCell>
        <TableCell className="hidden md:table-cell">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className={styles.dot} />
            {causeLabel}
          </span>
        </TableCell>
        <TableCell className="pharos-numeric px-2 text-xs sm:px-3 sm:text-sm">{formatRegisterDeathDate(row.deathDate)}</TableCell>
        <TableCell className="pharos-numeric px-2 text-right text-xs sm:px-3 sm:text-sm">
          {row.peak === null ? NOT_RECORDED : formatCemeteryPeak(row.peak)}
        </TableCell>
        <TableCell className="pharos-numeric hidden text-xs md:table-cell">{row.pegCurrency}</TableCell>
        <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">
          {row.mechanismArchetype ? MECHANISM_ARCHETYPE_SHORT_LABELS[row.mechanismArchetype] : NOT_RECORDED}
        </TableCell>
        <TableCell className="hidden lg:table-cell">
          <span className="flex gap-1">
            {row.tracked ? (
              <span className={styles.tag} title="Pharos tracked this coin; its frozen detail page is online">
                Archive
              </span>
            ) : (
              <span className="sr-only">Curated record</span>
            )}
            {row.caseStudy ? <span className={styles.tag}>Case study</span> : null}
          </span>
        </TableCell>
        <TableCell className="hidden xl:table-cell">
          {row.epitaph ? (
            <span className={styles.epitaphCell} title={row.epitaph}>
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
            className={`pharos-focus-ring ${styles.disclosure}`}
          />
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

/**
 * A folded record in the pristine register (no filter, default sort, not shown
 * in full): one compact row instead of the full row and its autopsy. Hidden by
 * CSS unless it is the `:target`, it carries everything a `#<id>` link needs
 * without JS. Any interaction that unfolds rows swaps in the full row pair.
 */
export function CemeteryRegisterFoldedRow({ row, columnCount }: { row: CemeteryRegisterRow; columnCount: number }) {
  return (
    <TableRow id={row.id} data-folded="" rowIntent="static" style={causeColorVars(row.cause)}>
      <TableCell colSpan={columnCount} className={cn(styles.folded, "whitespace-normal px-4 py-3")}>
        {/* Template strings keep each run one text node (no React `<!-- -->` separators in the HTML). */}
        <p>
          <span className={styles.symbol}>{row.symbol}</span>
          {` ${row.name} · `}
          <span aria-hidden="true" className={styles.dot} />
          {`${CAUSE_META[row.cause].label} · ${formatRegisterDeathDate(row.deathDate)}`}
        </p>
        {row.epitaph ? <p className={styles.foldedEpitaph}>{row.epitaph}</p> : null}
        <p className={styles.obituary}>{row.obituary}</p>
        <a href={row.sourceUrl} target="_blank" rel="noopener noreferrer" className="pharos-prose-link">
          {`Source: ${row.sourceLabel}`}
          <span aria-hidden="true">&nbsp;↗</span>
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </TableCell>
    </TableRow>
  );
}
