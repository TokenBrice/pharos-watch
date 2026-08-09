import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Label size: `sm` under rail-card prose (`text-xs`), `md` under the wider
 * in-flow prose (`text-sm`) — the toggle tracks the paragraph it folds.
 */
const INLINE_TOGGLE_TEXT_CLASS = { sm: "text-[11px]", md: "text-xs" } as const;

export type InlineDisclosureToggleSize = keyof typeof INLINE_TOGGLE_TEXT_CLASS;

/**
 * The in-module fold control: the frost-blue chevron button that reveals
 * reviewed detail in place ("Read more", "Why", "How each was measured").
 *
 * This is a control *inside* a module, not a module's own disclosure — modules
 * fold their named sections behind `ModuleDisclosure` and their citations
 * behind `EvidenceFooter`. Red styling is reserved for active issues, so this
 * control never carries tone.
 */
export function InlineDisclosureToggle({
  open,
  onToggle,
  collapsedLabel,
  expandedLabel = "Show less",
  size = "sm",
  className,
}: {
  open: boolean;
  onToggle: () => void;
  collapsedLabel: string;
  expandedLabel?: string;
  size?: InlineDisclosureToggleSize;
  /** Placement utilities only (margins, `sm:hidden`) — never restyling. */
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "pharos-focus-ring inline-flex min-h-7 items-center gap-1 rounded-sm font-medium text-frost-blue",
        INLINE_TOGGLE_TEXT_CLASS[size],
        className,
      )}
    >
      {open ? expandedLabel : collapsedLabel}
      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} aria-hidden="true" />
    </button>
  );
}

/**
 * The muted "Show all N …" control that lengthens a truncated list. Unlike
 * `InlineDisclosureToggle` it carries no chevron: the list itself is the
 * affordance, and the count is the information.
 */
export function ShowAllToggle({
  open,
  onToggle,
  total,
  noun,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  total: number;
  /** Plural noun for the collapsed label, e.g. "variants". */
  noun: string;
  /** Placement utilities only (margins, `sm:hidden`) — never restyling. */
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "pharos-focus-ring inline-flex min-h-11 w-fit items-center px-2.5 text-xs font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline lg:min-h-9",
        className,
      )}
    >
      {open ? "Show less" : `Show all ${total} ${noun}`}
    </button>
  );
}
