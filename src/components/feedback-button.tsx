"use client";

import { getRouteCapabilities } from "@/lib/route-capabilities";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { MessageSquarePlus } from "lucide-react";
import { FeedbackModal } from "@/components/feedback-modal-lazy";

/** Routes without the floating feedback entry. `/api/` keeps key requests off the public-GitHub feedback modal. */
export function isFeedbackHiddenPath(pathname: string | null): boolean {
  return !getRouteCapabilities(pathname).feedback;
}

/** Stablecoin dossiers already expose Share -> Report a data issue and a bottom Report issue action. */
function isStablecoinDossierPath(pathname: string | null): boolean {
  return pathname?.startsWith("/stablecoin/") === true;
}

export function FeedbackButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  if (isFeedbackHiddenPath(pathname) || isStablecoinDossierPath(pathname)) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Send feedback"
        title="Send feedback"
        // Icon-only and pinned strictly to the xl page gutter (xl:px-9 leaves 36px)
        // with ScrollToTop stacked above it, so it never crowds content below xl.
        className="pharos-focus-ring fixed right-1 bottom-3 z-chrome hidden size-8 items-center justify-center rounded-md border border-border/70 bg-background/90 text-muted-foreground backdrop-blur-sm transition-colors hover:border-border hover:bg-card hover:text-foreground xl:flex"
      >
        <MessageSquarePlus aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      </button>
      {open && <FeedbackModal open={open} onOpenChange={setOpen} />}
    </>
  );
}
