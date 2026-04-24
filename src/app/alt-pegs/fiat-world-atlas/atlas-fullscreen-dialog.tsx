"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PegDiversityHeroLive } from "@/app/alt-pegs/fiat-world-atlas/peg-diversity-hero-live";
import { WorldMap } from "@/app/alt-pegs/fiat-world-atlas/world-map";
import { useBrowserFullscreen } from "@/app/alt-pegs/fiat-world-atlas/use-browser-fullscreen";

const DIALOG_CONTENT_CLASSES =
  "atlas-fullscreen-dialog__content fixed inset-2 top-2 left-2 h-auto w-auto max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-2xl border-border/70 p-0 shadow-2xl sm:inset-4 sm:top-4 sm:left-4 sm:max-w-none";

export function AtlasFullscreenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const contentRef = useBrowserFullscreen(open);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={contentRef}
        className={DIALOG_CONTENT_CLASSES}
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
      >
        <div className="atlas-fullscreen-dialog__toolbar">
          <DialogTitle className="atlas-fullscreen-dialog__title">
            Peg Diversity Atlas
          </DialogTitle>
          <DialogDescription className="sr-only">
            Expanded inspection view of the Peg Diversity Atlas. Press Escape to close.
          </DialogDescription>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close atlas"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <div className="atlas-fullscreen-dialog__body">
          <div
            className="peg-hero__viewport"
            role="group"
            aria-label="Peg diversity map atlas"
          >
            <PegDiversityHeroLive worldMap={<WorldMap />} variant="fullscreen" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
