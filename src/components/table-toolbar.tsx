"use client";

import { Download, Equal, Menu, Search } from "lucide-react";
import { TableToolbarFrame } from "@/components/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ColumnVisibilityDropdown } from "./stablecoin-table-column-visibility";
import type { TableDensity } from "@/hooks/use-table-density";
import type { ColumnId } from "@/hooks/use-preferences";

interface TableToolbarProps {
  // Density
  density: TableDensity;
  onDensityChange: (density: TableDensity) => void;

  // Columns
  visibleColumns: ColumnId[];
  onVisibleColumnsChange: (value: ColumnId[] | ((prev: ColumnId[]) => ColumnId[])) => void;
  onResetColumns: () => void;
  defaultColumns: ColumnId[];

  // Export
  onExport: () => void;
  exportDisabled?: boolean;

  // Additional actions
  additionalActions?: React.ReactNode;

  // Search — when `onSearchChange` is supplied the toolbar renders a rounded
  // search field on the leading edge of the row (Figma table-overview layout).
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

const DENSITY_OPTIONS: { value: TableDensity; label: string; icon: typeof Menu }[] = [
  { value: "compact", label: "Compact", icon: Menu },
  { value: "spacious", label: "Spacious", icon: Equal },
];

// Inline icon-only segmented control (Figma toolbar): two view densities sit
// directly in the toolbar beside Columns / Export rather than behind a menu.
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
        "inline-flex items-center",
        variant === "figmaOverview"
          ? "h-8 w-[84px] gap-0.5 rounded-[10px] border border-border/70 bg-muted/50 p-1 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.7)] dark:border-white/10 dark:bg-neutral-900 dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.05)]"
          : "gap-0.5 rounded-lg border border-border/70 bg-background/40 p-0.5",
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
              "pharos-focus-ring inline-flex items-center justify-center transition-colors",
              variant === "figmaOverview" ? "h-6 w-9 rounded-[7px]" : "size-11 rounded-md sm:size-8",
              isActive
                ? variant === "figmaOverview"
                  ? "bg-card text-foreground shadow-[inset_0_1px_0_rgb(255_255_255_/_0.9),0_1px_2px_rgb(0_0_0_/_0.12)] dark:bg-neutral-700 dark:text-neutral-50 dark:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08),0_1px_2px_rgb(0_0_0_/_0.35)]"
                  : "bg-muted text-foreground shadow-sm"
                : variant === "figmaOverview"
                  ? "text-muted-foreground hover:text-foreground dark:text-neutral-500 dark:hover:text-neutral-200"
                  : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className={variant === "figmaOverview" ? "h-4 w-4 stroke-[1.75]" : "h-4 w-4"} aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

// Rounded search field that sits on the leading edge of the toolbar row,
// mirroring the Figma "Stablecoin Overview" table header. Drives the table's
// existing `searchQuery` filter — no new filtering logic.
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
        variant === "figmaOverview" ? "min-w-[6.75rem] flex-1 sm:w-[200px] sm:flex-none" : "sm:max-w-xs",
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
          "pharos-focus-ring w-full border border-border/70 bg-background/40 text-sm text-foreground placeholder:text-muted-foreground transition-colors hover:border-border",
          variant === "figmaOverview" ? "h-8 rounded-lg pl-8 pr-3" : "h-11 rounded-full pl-9 pr-3 sm:h-9",
        )}
      />
    </div>
  );
}

export function TableToolbar({
  density,
  onDensityChange,
  visibleColumns,
  onVisibleColumnsChange,
  onResetColumns,
  defaultColumns,
  onExport,
  exportDisabled,
  additionalActions,
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search stablecoins",
  eyebrow = "Table Controls",
  description = DEFAULT_TOOLBAR_DESCRIPTION,
  titleId,
  meta,
  variant = "default",
}: TableToolbarProps) {
  const searchField = onSearchChange ? (
    <TableSearchField
      value={searchValue ?? ""}
      onChange={onSearchChange}
      placeholder={searchPlaceholder}
      variant={variant}
    />
  ) : null;

  const actions = (
    <>
      {additionalActions}
      <DensitySegmented value={density} onChange={onDensityChange} variant={variant} />
      <ColumnVisibilityDropdown
        visibleColumns={visibleColumns}
        setVisibleColumns={onVisibleColumnsChange}
        resetColumns={onResetColumns}
        defaultColumns={defaultColumns}
        triggerClassName={variant === "figmaOverview" ? "h-8 min-h-8 w-auto rounded-lg px-2 sm:px-3" : undefined}
        compactOnMobile={variant === "figmaOverview"}
      />
      <Button
        variant="outline"
        size="sm"
        aria-label={variant === "figmaOverview" ? "Export CSV" : undefined}
        className={cn("rounded-lg", variant === "figmaOverview" ? "h-8 min-h-8 px-2 sm:px-3" : "min-h-11 sm:min-h-8")}
        onClick={onExport}
        disabled={exportDisabled}
      >
        <Download className="mr-1.5 h-3.5 w-3.5" />
        <span className={variant === "figmaOverview" ? "hidden sm:inline" : undefined}>Export CSV</span>
        {variant === "figmaOverview" ? <span className="sm:hidden">CSV</span> : null}
      </Button>
    </>
  );

  if (variant === "figmaOverview") {
    return (
      <div className="pharos-overview-table-toolbar flex flex-wrap items-center gap-2">
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
