import { ChevronDown } from "lucide-react";

const FRAMED_DETAILS_CLASS_NAME = "group rounded-lg border border-border/50";
const UNFRAMED_DETAILS_CLASS_NAME = "group border-t border-border/55";
const FRAMED_SUMMARY_CLASS_NAME =
  "pharos-focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-colors hover:bg-muted/40 [&::-webkit-details-marker]:hidden";
const UNFRAMED_SUMMARY_CLASS_NAME =
  "pharos-focus-ring flex cursor-pointer list-none items-center justify-between gap-3 rounded-sm px-0 py-3 text-sm font-medium transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden";
const FRAMED_BODY_CLASS_NAME = "px-4 pb-4 text-sm leading-relaxed text-muted-foreground";
const UNFRAMED_BODY_CLASS_NAME = "px-0 pb-1 text-sm leading-relaxed text-muted-foreground";

/**
 * Collapsed `<details>` in the `FaqSection` style, for secondary terms on `/api/`.
 * `framed={false}` drops the border box for use inside a card, keeping a top rule.
 */
export function ApiDisclosure({
  summary,
  children,
  framed = true,
}: {
  summary: string;
  children: React.ReactNode;
  framed?: boolean;
}) {
  return (
    <details className={framed ? FRAMED_DETAILS_CLASS_NAME : UNFRAMED_DETAILS_CLASS_NAME}>
      <summary className={framed ? FRAMED_SUMMARY_CLASS_NAME : UNFRAMED_SUMMARY_CLASS_NAME}>
        {summary}
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180 motion-reduce:transition-none"
        />
      </summary>
      <div className={framed ? FRAMED_BODY_CLASS_NAME : UNFRAMED_BODY_CLASS_NAME}>{children}</div>
    </details>
  );
}
