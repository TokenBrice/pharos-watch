"use client";

import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

interface SectionBannerProps {
  id: string;
  label: string;
  icon?: LucideIcon;
  active?: boolean;
  className?: string;
}

export function SectionBanner({
  id,
  label,
  icon: Icon,
  active = false,
  className,
}: SectionBannerProps) {
  const handleCopy = () => {
    if (
      typeof window === "undefined" ||
      typeof navigator === "undefined" ||
      !navigator.clipboard
    ) {
      return;
    }
    navigator.clipboard
      .writeText(`${window.location.origin}${window.location.pathname}#${id}`)
      .catch(() => {
        // Clipboard write can reject (denied permission / insecure context);
        // the anchor still navigates to #id, so the user can copy the URL bar.
      });
  };
  return (
    <div
      className={cn(
        // my-8: summary-first modules compressed the zones, so the old my-12
        // banners were carrying more vertical weight than the content they
        // announce.
        "my-8 flex items-center justify-center gap-6 text-muted-foreground",
        className,
      )}
      role="presentation"
    >
      <span
        aria-hidden
        className="h-px w-full max-w-[180px] flex-1 bg-[var(--section-rule)]"
      />
      <h2 id={id} className="pharos-kicker scroll-mt-32 sm:text-[12px]">
        <a
          href={`#${id}`}
          onClick={handleCopy}
          aria-label={`Copy link to ${label} section`}
          className="pharos-focus-ring group inline-flex min-h-11 items-center gap-2.5 rounded-sm px-2 py-2 sm:min-h-0 sm:px-0 sm:py-0"
        >
          {Icon ? (
            <Icon aria-hidden className="h-4 w-4 text-muted-foreground" />
          ) : null}
          <span
            className={cn(
              "transition-colors",
              active ? "text-foreground" : "text-foreground/85",
            )}
          >
            {label}
          </span>
          <span
            aria-hidden
            className="text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          >
            #
          </span>
        </a>
      </h2>
      <span
        aria-hidden
        className="h-px w-full max-w-[180px] flex-1 bg-[var(--section-rule)]"
      />
    </div>
  );
}
