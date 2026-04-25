"use client";

import { useRef } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useBrowserFullscreen } from "@/hooks/use-browser-fullscreen";
import type { LighthouseCinematicModel, LighthouseMode, LighthouseModuleId } from "./cinematic-model";
import { LighthouseStage } from "./lighthouse-stage";

const DIALOG_CONTENT_CLASSES =
  "lh-fullscreen-dialog__content fixed inset-2 top-2 left-2 h-auto w-auto max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-border/70 p-0 shadow-2xl sm:inset-4 sm:top-4 sm:left-4 sm:max-w-none";

export function LighthouseFullscreenDialog({
  open,
  model,
  onOpenChange,
  onModeChange,
  onPreviewModule,
  onPreviewModuleEnd,
  onSelectModule,
  onSelectHarbor,
  onPreviewHarbor,
  onPreviewEnd,
}: {
  open: boolean;
  model: LighthouseCinematicModel;
  onOpenChange: (open: boolean) => void;
  onModeChange: (mode: LighthouseMode) => void;
  onPreviewModule?: (id: LighthouseModuleId) => void;
  onPreviewModuleEnd?: () => void;
  onSelectModule?: (id: LighthouseModuleId) => void;
  onSelectHarbor: (id: string) => void;
  onPreviewHarbor?: (id: string) => void;
  onPreviewEnd?: () => void;
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
        <div className="lh-fullscreen-dialog__toolbar">
          <DialogTitle className="sr-only">
            Pharos Lighthouse
          </DialogTitle>
          <DialogDescription className="sr-only">
            Expanded inspection view of the Pharos Lighthouse visualization. Press Escape to close.
          </DialogDescription>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close lighthouse"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" aria-hidden="true" />
          </Button>
        </div>
        <div className="lh-fullscreen-dialog__body">
          <LighthouseStage
            model={model}
            variant="fullscreen"
            ariaLabel="Pharos Lighthouse fullscreen stage"
            onModeChange={onModeChange}
            onPreviewModule={onPreviewModule}
            onPreviewModuleEnd={onPreviewModuleEnd}
            onSelectModule={onSelectModule}
            onSelectHarbor={onSelectHarbor}
            onPreviewHarbor={onPreviewHarbor}
            onPreviewEnd={onPreviewEnd}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
