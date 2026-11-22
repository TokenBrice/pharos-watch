"use client";

import { Download, Rows2, Rows3, Search } from "lucide-react";
import { TableToolbarFrame } from "@/components/table";
import { TableExportMenu, type TableExportMenuProps } from "@/components/table-export-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ColumnVisibilityDropdown } from "./stablecoin-directory/stablecoin-table-column-visibility";
import type { TableDensity } from "@/hooks/use-table-density";
import type { ColumnId } from "@/hooks/use-preferences";

export interface TableToolbarProps<T = unknown> {
  density?: TableDensity;
  onDensityChange?: (density: TableDensity) => void;

  visibleColumns?: ColumnId[];
  onVisibleColumnsChange?: (value: ColumnId[] | ((prev: ColumnId[]) => ColumnId[])) => void;
  onResetColumns?: () => void;
  defaultColumns?: ColumnId[];
  /** Columns selected by the user but temporarily hidden to fit the container width. */
  hiddenByFit?: readonly ColumnId[];
  /** Optional handler to reveal fit-hidden columns directly from the Columns menu. */
  onShowAllColumns?: () => void;

  onExport?: () => void;
  /** Provenance-bearing multi-format export menu (CSV, NDJSON, Markdown). */
  exportMenu?: TableExportMenuProps<T>;
  exportDisabled?: boolean;

  additionalActions?: React.ReactNode;

  // Search — when `onSearchChange` is supplied the toolbar renders a search
  // field on the leading edge of the row.
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;

  // Copy overrides — callers can swap the eyebrow or hide the description
  eyebrow?: string;
  description?: string | null;
  // When `titleId` is provided, the eyebrow is promoted to a proper h2 title
  // (used by compact homepage views to anchor the table region without a separate band).
  titleId?: string;
  meta?: string;
  variant?: "default" | "figmaOverview";
}

const DEFAULT_TOOLBAR_DESCRIPTION = "Tune density, hide noise, and export the current lens without leaving the table.";

const DENSITY_OPTIONS: { value: TableDensity; label: string; icon: typeof Rows3 }[] = [
  { value: "compact", label: "Compact", icon: Rows3 },
  { value: "spacious", label: "Spacious", icon: Rows2 },
];

// Inline icon-only segmented control: two view densities sit directly in the
// toolbar beside Columns / Export rather than behind a menu.
function DensitySegmented({
  value,
  onChange,
  variant = "default",
}: {
  value: TableDensity;
  onChange: (density: TableDensity) => void;
  variant?: "default" | "figmaOverview";
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Table density"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5",
        variant === "figmaOverview" && "bg-card",
      )}
    >
      {DENSITY_OPTIONS.map((option) => {
        const Icon = option.icon;
        const isActive = value === option.value;
        return (
          <button
            type="button"
            key={option.value}
            role="radio"
            aria-checked={isActive}
            aria-label={`${option.label} rows`}
            title={`${option.label} view`}
            onClick={() => onChange(option.value)}
            className={cn(
              "pharos-focus-ring inline-flex size-11 items-center justify-center rounded-md transition-colors sm:size-7",
              isActive
                ? "bg-muted text-foreground ring-1 ring-border/70"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

// Search field that sits on the leading edge of the toolbar row. Drives the
// table's existing `searchQuery` filter — no new filtering logic.
function TableSearchField({
  value,
  onChange,
  placeholder,
  variant = "default",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  variant?: "default" | "figmaOverview";
}) {
  return (
    <div
      className={cn(
        "relative w-full",
        variant === "figmaOverview" ? "min-w-[6.75rem] flex-1 sm:w-[220px] sm:flex-none" : "sm:max-w-xs",
      )}
    >
      <Search
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
          variant === "figmaOverview" ? "left-2.5 size-4" : "left-3 size-4",
        )}
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cn(
          "pharos-focus-ring w-full border border-border bg-card text-sm text-foreground placeholder:text-muted-foreground transition-colors hover:border-border",
          variant === "figmaOverview" ? "h-11 rounded-md pl-8 pr-3 sm:h-8" : "h-11 rounded-full pl-9 pr-3 sm:h-9",
        )}
      />
    </div>
  );
}

export function TableToolbar<T = unknown>({
  density,
  onDensityChange,
  visibleColumns,
  onVisibleColumnsChange,
  onResetColumns,
  defaultColumns,
  hiddenByFit,
  onShowAllColumns,
  onExport,
  exportMenu,
  exportDisabled,
  additionalActions,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search stablecoins",
  eyebrow = "Table controls",
  description = DEFAULT_TOOLBAR_DESCRIPTION,
  titleId,
  meta,
  variant = "default",
}: TableToolbarProps<T>) {
  const isOverview = variant === "figmaOverview";
  const searchField = onSearchChange ? (
    <TableSearchField
      value={searchValue ?? ""}
      onChange={onSearchChange}
      placeholder={searchPlaceholder}
      variant={variant}
    />
  ) : null;

  const exportControl = exportMenu ? (
    <TableExportMenu
      {...exportMenu}
      disabled={exportMenu.disabled ?? exportDisabled}
      triggerClassName={cn(
        isOverview ? "h-11 px-2.5 sm:h-8 sm:px-3" : "min-h-11 sm:min-h-8",
        exportMenu.triggerClassName,
      )}
    />
  ) : onExport ? (
    <Button
      variant="outline"
      size="sm"
      aria-label={isOverview ? "Export CSV" : undefined}
      className={cn("rounded-md", isOverview ? "h-11 px-2.5 sm:h-8 sm:px-3" : "min-h-11 sm:min-h-8")}
      onClick={onExport}
      disabled={exportDisabled}
    >
      <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
      <span className={isOverview ? "hidden sm:inline" : undefined}>Export CSV</span>
      {isOverview ? <span className="sm:hidden">CSV</span> : null}
    </Button>
  ) : null;

  const actions = (
    <>
      {additionalActions}
      {density && onDensityChange ? (
        <DensitySegmented value={density} onChange={onDensityChange} variant={variant} />
      ) : null}
      {visibleColumns && onVisibleColumnsChange && onResetColumns && defaultColumns ? (
        <ColumnVisibilityDropdown
          visibleColumns={visibleColumns}
          setVisibleColumns={onVisibleColumnsChange}
          resetColumns={onResetColumns}
          defaultColumns={defaultColumns}
          hiddenByFit={hiddenByFit}
          onShowAllColumns={onShowAllColumns}
          triggerClassName={isOverview ? "h-11 w-auto rounded-md px-2.5 sm:h-8 sm:px-3" : undefined}
          compactOnMobile={isOverview}
        />
      ) : null}
      {exportControl}
    </>
  );

  if (isOverview) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        {searchField}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
      </div>
    );
  }

  return (
    <TableToolbarFrame eyebrow={eyebrow} description={description} titleId={titleId} meta={meta} actions={actions}>
      {searchField}
    </TableToolbarFrame>
  );
}
