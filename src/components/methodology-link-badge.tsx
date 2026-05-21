"use client";

import Link from "next/link";
import { BookOpen } from "lucide-react";
import { methodologyAnchorFor, type MetricKey } from "@/lib/methodology-anchors";
import { cn } from "@/lib/utils";

export interface MethodologyLinkBadgeProps {
  metric: MetricKey;
  /** Optional explicit label override. Defaults to "method". */
  label?: string;
  /**
   * Reveal mode:
   * - `"always"` (default): visible at low contrast on hero/score cards
   * - `"hover"`: hidden until the parent `.group` is hovered/focused
   *   (used in dense tables)
   */
  reveal?: "always" | "hover";
  className?: string;
}

export function MethodologyLinkBadge({
  metric,
  label = "method",
  reveal = "always",
  className,
}: MethodologyLinkBadgeProps) {
  const href = methodologyAnchorFor(metric);
  const accessibleMetric = metric.replace(/-/g, " ");
  return (
    <Link
      href={href}
      aria-label={`How ${accessibleMetric} is calculated`}
      className={cn(
        "pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-3xs text-muted-foreground/70 transition-colors hover:text-foreground",
        reveal === "hover"
          ? "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
          : "",
        className,
      )}
    >
      <BookOpen aria-hidden="true" size={10} strokeWidth={1.5} />
      <span className="font-mono uppercase tracking-wide">{label}</span>
    </Link>
  );
}
