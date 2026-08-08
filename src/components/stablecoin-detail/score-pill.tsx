import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The one score presentation for detail-page module headers: an outline badge
 * with a mono numeral, tone-classed by the owning score band. Wrap with
 * `ScoreBadgeWrapper` at the call site when the pill should open methodology
 * context.
 */
export function ScorePill({
  label,
  toneClass,
  size = "sm",
  title,
  className,
}: {
  /** Preformatted score, e.g. "79/100" or "NR". */
  label: string;
  /** Band tone classes (border/bg/text) from the owning view model. */
  toneClass?: string;
  size?: "sm" | "lg";
  title?: string;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn(
        "pharos-numeric",
        size === "lg" ? "px-2.5 py-1 text-lg" : "px-2 py-0.5 text-sm",
        toneClass ?? "border-border/60 bg-muted/30 text-muted-foreground",
        className,
      )}
    >
      {label}
    </Badge>
  );
}
