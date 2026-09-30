"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableEmptyRow, DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { useHydrated } from "@/hooks/use-hydrated";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import { useUrlFilters } from "@/hooks/use-url-filters";
import type { CemeteryRegisterRow, RegisterFilterOptions } from "@/lib/cemetery-register";
import {
  buildRegisterHref,
  parseRegisterFilters,
  type CemeteryRegisterFilters,
  type CemeteryRegisterSortKey,
} from "@/lib/cemetery-selection";
import { cn } from "@/lib/utils";
import { CemeterySectionHeader } from "./cemetery-section-header";
import { useCemeterySelection, type CemeterySelectionHandler } from "./cemetery-selection-context";
import {
  REGISTER_FOLD_COUNT,
  hasActiveRegisterFilters,
  matchesRegisterFilters,
  nextRegisterSort,
  registerCaption,
  registerSearchText,
  registerSortParams,
  resolveRegisterSort,
  sortRegisterRows,
  withoutRegisterFilters,
} from "./cemetery-register-model";
import { CemeteryRegisterFoldedRow, CemeteryRegisterRowPair } from "./cemetery-register-row";
import { CemeteryRegisterToolbar } from "./cemetery-register-toolbar";
import styles from "./cemetery-register.module.css";

const REGISTER_COLUMNS: readonly DataTableColumn<CemeteryRegisterSortKey>[] = [
  { id: "coin", label: "Coin", sortKey: "name", className: "w-full px-2 sm:px-3" },
  { id: "cause", label: "Cause", sortKey: "cause", className: "hidden md:table-cell" },
  { id: "died", label: "Died", sortKey: "died", className: "px-2 sm:px-3" },
  // One sortable Peak column with a compact header below `md`; exactly one of the pair is displayed.
  { id: "peak", label: "Peak market cap", sortKey: "peak", className: "hidden text-right md:table-cell" },
  { id: "peak-compact", label: "Peak", sortKey: "peak", className: "px-2 text-right md:hidden" },
  { id: "peg", label: "Peg", className: "hidden md:table-cell" },
  { id: "mechanism", label: "Mechanism", className: "hidden lg:table-cell" },
  { id: "record", label: "Record", className: "hidden lg:table-cell" },
  { id: "epitaph", label: "Epitaph", className: "hidden xl:table-cell" },
  { id: "autopsy", label: <span className="sr-only">Autopsy</span>, className: "px-1" },
];
const COLUMN_COUNT = REGISTER_COLUMNS.length;

const HIGHLIGHT_MS = 2400;
const RESULT_ANNOUNCE_DELAY_MS = 300;
/** A reveal announces itself; the result-count change it causes stays quiet for this long. */
const REVEAL_ANNOUNCEMENT_HOLD_MS = 1500;

/** A fresh object per request, so repeating a request for the same row re-runs its effect. */
interface RowRequest {
  id: string;
}

interface FocusRequest extends RowRequest {
  /** Scroll the row into view first; null focuses only. */
  scroll: ScrollBehavior | null;
}

export interface CemeteryRegisterProps {
  /**
   * Server-projected by `buildCemeteryRegisterRows`. Must arrive in the default
   * "Died, newest first" order: the register sorts from it and treats it as
   * the tie-break order.
   */
  rows: readonly CemeteryRegisterRow[];
  /** `buildRegisterFilterOptions(stats, rows)`, built on the server. */
  filterOptions: RegisterFilterOptions;
}

/**
 * Autopsy Register (`#register`): every record, searchable, filterable and
 * sortable, with URL-backed filters. The server renders every record: the
 * first 25 as full rows with a hidden autopsy row, the rest as compact folded
 * rows. Folding and `#<id>` fragments work before hydration through CSS, then
 * `revealRecord` takes over. The selection provider owns the hash.
 */
export function CemeteryRegister({ rows, filterOptions }: CemeteryRegisterProps) {
  const { registerRevealRecord, setRecordHash, pinGrave } = useCemeterySelection();
  const { searchParams, isReady, replaceParams } = useUrlFilters();
  const hydrated = useHydrated();
  const reducedMotion = usePrefersReducedMotion();

  const [showAll, setShowAll] = useState(false);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [highlight, setHighlight] = useState<RowRequest | null>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [queryDraft, setQueryDraft] = useState<string | null>(null);

  const sectionRef = useRef<HTMLElement>(null);
  const announcedResultRef = useRef<string | null>(null);
  const holdResultAnnouncementUntilRef = useRef(0);

  const filters = useMemo(() => parseRegisterFilters(searchParams), [searchParams]);
  const filtersActive = hasActiveRegisterFilters(filters);
  const sort = useMemo(() => resolveRegisterSort(filters), [filters]);

  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const searchTextById = useMemo(() => new Map(rows.map((row) => [row.id, registerSearchText(row)])), [rows]);

  const sortedRows = useMemo(() => sortRegisterRows(rows, sort), [rows, sort]);
  const matchingRows = useMemo(
    () =>
      filtersActive
        ? sortedRows.filter((row) => matchesRegisterFilters(row, filters, searchTextById.get(row.id) ?? ""))
        : sortedRows,
    [filtersActive, sortedRows, filters, searchTextById],
  );

  const foldActive = !filtersActive && !showAll;
  // Folded rows render compact only in the pristine view the server also renders (so hydration matches);
  // once the reader sorts, filters, shows all or reveals a folded row, every row is a full row again.
  const compactFolds = sort.key === "died" && sort.dir === "desc";
  const view = matchingRows.map((row, index) => ({
    row,
    folded: foldActive && index >= REGISTER_FOLD_COUNT && !expandedIds.has(row.id),
  }));
  const foldedCount = view.filter((entry) => entry.folded).length;
  const shownCount = view.length - foldedCount;
  const total = rows.length;
  const resultLine = filtersActive ? `Showing ${shownCount} of ${total} matching` : `Showing ${shownCount} of ${total}`;

  // The raw draft keeps spaces the URL normaliser trims; a URL change from
  // elsewhere (reset, reveal, an in-page register link) wins over a stale draft.
  const draftQuery = queryDraft === null ? undefined : parseRegisterFilters(new URLSearchParams({ q: queryDraft })).q;
  const queryValue = queryDraft !== null && draftQuery === filters.q ? queryDraft : (filters.q ?? "");

  const writeFilters = useCallback(
    (next: CemeteryRegisterFilters) => {
      replaceParams((params) => {
        const href = buildRegisterHref(next, { base: params, pathname: "", hash: null });
        const rebuilt = new URLSearchParams(href.slice(href.indexOf("?") + 1));
        for (const key of [...params.keys()]) params.delete(key);
        rebuilt.forEach((value, key) => params.append(key, value));
      });
    },
    [replaceParams],
  );

  const handleQueryChange = (value: string) => {
    setQueryDraft(value);
    writeFilters({ ...filters, q: value });
  };

  const handleReset = () => {
    setQueryDraft(null);
    writeFilters(withoutRegisterFilters(filters));
  };

  const handleEmptyReset = () => {
    handleReset();
    document.getElementById("cemetery-register-cause-all")?.focus();
  };

  const handleShowAll = () => {
    const firstFolded = view.find((entry) => entry.folded);
    setShowAll(true);
    if (!firstFolded) return;
    setFocusRequest({ id: firstFolded.row.id, scroll: null });
  };

  const handleToggle = useCallback(
    (id: string, open: boolean) => {
      setExpandedIds((previous) => {
        const next = new Set(previous);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      });
      if (open) setRecordHash(id);
      else setHighlight((current) => (current?.id === id ? null : current));
    },
    [setRecordHash],
  );

  const handleShowOnField = useCallback((id: string) => pinGrave(id, "register"), [pinGrave]);

  const revealRecord = useCallback<CemeterySelectionHandler>(
    (id) => {
      const row = rowById.get(id);
      if (!row) return;
      const excluded = filtersActive && !matchesRegisterFilters(row, filters, searchTextById.get(id) ?? "");
      if (excluded) {
        setQueryDraft(null);
        writeFilters(withoutRegisterFilters(filters));
      }
      if ((!filtersActive || excluded) && sortedRows.indexOf(row) >= REGISTER_FOLD_COUNT) setShowAll(true);
      setExpandedIds((previous) => (previous.has(id) ? previous : new Set(previous).add(id)));

      setHighlight({ id });
      setFocusRequest({ id, scroll: reducedMotion ? "auto" : "smooth" });

      holdResultAnnouncementUntilRef.current = Date.now() + REVEAL_ANNOUNCEMENT_HOLD_MS;
      setAnnouncement(
        excluded ? `Filters cleared to show ${row.symbol}.` : `Opened autopsy for ${row.name} (${row.symbol}).`,
      );
      setRecordHash(id);
    },
    [rowById, filtersActive, filters, searchTextById, writeFilters, sortedRows, reducedMotion, setRecordHash],
  );

  // Register only once the URL filters are readable: a hash reveal requested
  // during hydration stays queued in the provider until then, so it judges
  // the real filters rather than the empty pre-hydration ones.
  useEffect(
    () => (isReady ? registerRevealRecord(revealRecord) : undefined),
    [isReady, registerRevealRecord, revealRecord],
  );

  // Scroll and focus after the reveal (or "Show all") has committed.
  useEffect(() => {
    if (!focusRequest) return;
    const row = document.getElementById(focusRequest.id);
    if (!row || !sectionRef.current?.contains(row)) return;
    if (focusRequest.scroll) row.scrollIntoView({ block: "start", behavior: focusRequest.scroll });
    row.querySelector<HTMLButtonElement>("button[aria-controls]")?.focus({ preventScroll: focusRequest.scroll !== null });
  }, [focusRequest]);

  useEffect(() => {
    if (!highlight || reducedMotion) return;
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight, reducedMotion]);

  // Debounced polite announcement of result-count changes; the first ready
  // render is the baseline, so loading a filtered URL stays quiet.
  useEffect(() => {
    if (!isReady) return;
    const previous = announcedResultRef.current;
    announcedResultRef.current = resultLine;
    if (previous === null || previous === resultLine) return;
    if (Date.now() < holdResultAnnouncementUntilRef.current) return;
    const timer = window.setTimeout(() => setAnnouncement(`${resultLine}.`), RESULT_ANNOUNCE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isReady, resultLine]);

  const highlightClassName = reducedMotion ? styles.outlined : styles.flash;

  return (
    <section
      ref={sectionRef}
      id="register"
      aria-labelledby="register-heading"
      data-enhanced={hydrated ? "" : undefined}
      // Gap, not child margins: the section is a layout-containment boundary (content-visibility), so a
      // trailing child margin would no longer collapse through it and would add space below the register.
      className={cn(styles.register, "flex min-w-0 flex-col gap-3")}
    >
      <CemeterySectionHeader
        id="register-heading"
        kicker="Autopsy register"
        title="Every documented death"
        meta="Search, filter, and sort all records. Open a row for the obituary, contracts, and source. Selecting a grave in the cemetery opens its row here."
      />
      <DataTableShell
        tableId="cemetery-register"
        columns={REGISTER_COLUMNS}
        sort={{
          sortKey: sort.key,
          sortDirection: sort.dir,
          toggleSort: (key) => writeFilters({ ...filters, ...registerSortParams(nextRegisterSort(sort, key)) }),
          getAriaSortValue: (key) => (key === sort.key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"),
        }}
        caption={registerCaption(matchingRows.length, sort)}
        captionClassName="sr-only"
        // Below `md` only Coin, Died, Peak and the disclosure show and the name truncates, so nothing scrolls sideways.
        mobileScrollHint={false}
        topSlot={
          <CemeteryRegisterToolbar
            filters={filters}
            filtersActive={filtersActive}
            queryValue={queryValue}
            resultLine={resultLine}
            options={filterOptions}
            onQueryChange={handleQueryChange}
            onCauseChange={(cause) => writeFilters({ ...filters, cause })}
            onFacetChange={(key, value) =>
              writeFilters({ ...filters, [key]: value === "" ? undefined : value } as CemeteryRegisterFilters)
            }
            onReset={handleReset}
          />
        }
      >
        {view.map(({ row, folded }) =>
          folded && compactFolds ? (
            <CemeteryRegisterFoldedRow key={row.id} row={row} columnCount={COLUMN_COUNT} />
          ) : (
            <CemeteryRegisterRowPair
              key={row.id}
              row={row}
              folded={folded}
              expanded={expandedIds.has(row.id)}
              highlightClassName={highlight?.id === row.id ? highlightClassName : undefined}
              columnCount={COLUMN_COUNT}
              onToggle={handleToggle}
              onShowOnField={handleShowOnField}
            />
          ),
        )}
        {view.length === 0 ? (
          <DataTableEmptyRow colSpan={COLUMN_COUNT} className="whitespace-normal px-4 py-6">
            <div className="pharos-empty-note mx-auto flex max-w-md flex-col items-center gap-2">
              <p>No records match these filters.</p>
              <button type="button" onClick={handleEmptyReset} className="pharos-prose-link inline-flex min-h-11 items-center md:min-h-0">
                Reset filters
              </button>
            </div>
          </DataTableEmptyRow>
        ) : null}
        {foldedCount > 0 ? (
          <TableRow rowIntent="static" className="hover:bg-transparent">
            <TableCell colSpan={COLUMN_COUNT} className="whitespace-normal px-3 py-3 sm:px-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="pharos-meta">
                  {foldedCount} more records below the first {REGISTER_FOLD_COUNT}.
                </p>
                <button type="button" onClick={handleShowAll} className="pharos-focus-ring pharos-control-pill min-h-11 md:min-h-9">
                  Show all {total} records
                </button>
              </div>
            </TableCell>
          </TableRow>
        ) : !filtersActive && view.length > 0 ? (
          <TableRow rowIntent="static" className="hover:bg-transparent">
            <TableCell colSpan={COLUMN_COUNT} className="whitespace-normal px-3 py-3 sm:px-4">
              <p className="pharos-meta">
                All {total} records shown.{" "}
                <a href="#dataset" className="pharos-prose-link">
                  Download the dataset
                </a>
              </p>
            </TableCell>
          </TableRow>
        ) : null}
      </DataTableShell>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}
