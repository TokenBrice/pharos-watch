import type { DetailsHTMLAttributes, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface DisclosureChevronProps {
  className?: string;
}

/**
 * Shared rotating chevron for native `<details>` disclosures. Requires an
 * ancestor `<details>` carrying `group/disclosure` (or `group`).
 */
export function DisclosureChevron({ className }: DisclosureChevronProps) {
  return (
    <ChevronDown
      aria-hidden="true"
      className={cn(
        "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open/disclosure:rotate-180 motion-reduce:transition-none",
        className,
      )}
    />
  );
}

export const DISCLOSURE_SUMMARY_RESET_CLASS =
  "pharos-focus-ring cursor-pointer list-none [&::-webkit-details-marker]:hidden";

export interface DisclosurePanelProps extends Omit<DetailsHTMLAttributes<HTMLDetailsElement>, "children"> {
  /** Content rendered inside the clickable `<summary>` row. */
  summary: ReactNode;
  /** Surface framing: `inset` (`rounded-lg`, inside a card), `band` (muted tinted inset), or `plain` (inline). */
  variant?: "inset" | "band" | "plain";
  /** Chevron placement relative to the summary content. */
  chevronPosition?: "end" | "start";
  /** Optional class override on `<summary>`. */
  summaryClassName?: string;
  /** Optional class override on the expanded content container. */
  contentClassName?: string;
  /** Optional class override on the chevron icon. */
  chevronClassName?: string;
  children: ReactNode;
}

const FRAME_VARIANT_CLASS: Record<NonNullable<DisclosurePanelProps["variant"]>, string> = {
  inset: "pharos-inset overflow-hidden",
  band: "overflow-hidden rounded-lg border border-border/60 bg-muted/25",
  plain: "",
};

const SUMMARY_VARIANT_CLASS: Record<NonNullable<DisclosurePanelProps["variant"]>, string> = {
  inset:
    "flex min-h-11 items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/35 sm:min-h-10",
  band:
    "flex min-h-11 items-center justify-between gap-3 px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted/40 sm:min-h-10",
  plain:
    "inline-flex min-h-11 w-fit items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:min-h-8",
};

const CONTENT_VARIANT_CLASS: Record<NonNullable<DisclosurePanelProps["variant"]>, string> = {
  inset: "border-t border-border/50 px-4 py-3.5",
  band: "border-t border-border/50 px-4 py-3.5",
  plain: "mt-2",
};

/**
 * Server-safe native `<details>` disclosure following Pharos's chevron
 * disclosure grammar (`docs/design-language.md`). Keeps hidden content in
 * static HTML for crawlability and find-in-page while eliminating raw browser
 * disclosure triangles and nested `rounded-xl` cards.
 */
export function DisclosurePanel({
  summary,
  variant = "inset",
  chevronPosition = "end",
  className,
  summaryClassName,
  contentClassName,
  chevronClassName,
  children,
  ...detailsProps
}: DisclosurePanelProps) {
  const chevron = (
    <DisclosureChevron
      className={cn(variant === "plain" && "h-3.5 w-3.5", chevronClassName)}
    />
  );

  return (
    <details
      className={cn("group/disclosure", FRAME_VARIANT_CLASS[variant], className)}
      {...detailsProps}
    >
      <summary
        className={cn(
          DISCLOSURE_SUMMARY_RESET_CLASS,
          SUMMARY_VARIANT_CLASS[variant],
          summaryClassName,
        )}
      >
        {chevronPosition === "start" ? chevron : null}
        <span className="min-w-0 flex-1">{summary}</span>
        {chevronPosition === "end" ? chevron : null}
      </summary>
      <div className={cn(CONTENT_VARIANT_CLASS[variant], contentClassName)}>
        {children}
      </div>
    </details>
  );
}
