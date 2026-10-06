import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Label size: `sm` under rail-card prose (`text-xs`), `md` under the wider
 * in-flow prose (`text-sm`) — the toggle tracks the paragraph it folds.
 */
const INLINE_TOGGLE_TEXT_CLASS = { sm: "text-[11px]", md: "text-xs" } as const;

export type InlineDisclosureToggleSize = keyof typeof INLINE_TOGGLE_TEXT_CLASS;

/**
 * The in-module fold control for prose that folds in place ("Read the full
 * note"): the `ModuleDisclosure` summary grammar — muted dashed label with a
 * trailing chevron — on a button, because the text it folds is a paragraph the
 * module owns rather than a named section.
 *
 * Modules fold named sections behind `ModuleDisclosure` and citations behind
 * `EvidenceFooter`. Red styling is reserved for active issues, so this control
 * never carries tone, and it never uses link color: cyan text reads as a link
 * to somewhere else, not as a fold.
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
        "pharos-focus-ring inline-flex min-h-8 items-center gap-1.5 rounded-md text-muted-foreground",
        INLINE_TOGGLE_TEXT_CLASS[size],
        className,
      )}
    >
      <span className="underline decoration-dashed underline-offset-2">{open ? expandedLabel : collapsedLabel}</span>
      <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
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
