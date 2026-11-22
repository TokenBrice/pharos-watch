"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, ImageOff, ZoomIn } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useImageUnavailable } from "@/hooks/use-image-unavailable";
import { cn } from "@/lib/utils";

/**
 * The poster bytes are served by `functions/safety-scores/map.png.ts` out of KV,
 * not by the static export, so the image cadence is decoupled from Pages
 * deploys. Two states therefore have to look deliberate rather than broken:
 *
 * - a contributor running `npm run dev`, where no Pages Function exists at all;
 * - production after the kill switch, where the Function answers 404. This is
 *   lever 2 of the documented kill switch, so the panel below is the real
 *   degradation contract, not a development nicety.
 *
 * Detecting the failure needs *two* paths, and `onError` alone is not enough.
 * The `<img>` is server-rendered, so the browser starts fetching it during
 * parse: for an already-404ing URL the `error` event fires long before React
 * hydrates and attaches the handler, and React does not replay events it missed.
 * The ref callback closes that window by inspecting the element's own state the
 * moment React attaches to it (`complete` with a zero `naturalWidth` means the
 * fetch already finished and produced no image), while `onError` still covers
 * failures that happen after hydration.
 */
const POSTER_PATH = "/safety-scores/map.png";
const POSTER_FILENAME = "pharos-safety-score-map.png";

/**
 * The published raster, in real pixels. The generator composes a 1600x900
 * layout and screenshots it at `DEVICE_SCALE = 2`, asserting the result is
 * exactly this size (see `scripts/maintenance/build-safety-score-map.ts`). The
 * `<img>` is sized entirely by CSS below, so these serve as the intrinsic
 * aspect ratio the browser reserves layout space from, and as the figure quoted
 * to the reader on the download control.
 */
const POSTER_WIDTH = 3200;
const POSTER_HEIGHT = 1800;

const POSTER_ALT =
  "The Pharos Stablecoin Safety Map: five discrete grade bands from A at the center outward to B, C, D, and F; orbit indicates grade band rather than a continuous score; bubble area tracks circulating supply above a per-tier minimum marker while smaller assets share a fixed presence marker. Corner notes record render thresholds, methodology version, data date, graded count, and mapped supply. The same figures are available as a sortable table on the Safety Scores page.";

function PosterUnavailable() {
  return (
    <div className="pharos-card-shell p-6 sm:p-8">
      <div className="flex flex-col items-start gap-3">
        <ImageOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-2">
          <p className="pharos-section-title">The map is not available right now</p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            The poster is rebuilt and republished once a day, separately from the site itself, so it
            can briefly be missing while a rebuild is in flight. It is also absent in local
            development, where nothing publishes it.
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Every grade the map draws is available as live, sortable data on the{" "}
            <Link href="/safety-scores/" className="pharos-prose-link">
              Safety Scores page
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

export function SafetyMapPoster() {
  const { unavailable, checkAlreadyFailed, onError } = useImageUnavailable();
  const [zoomMode, setZoomMode] = useState<"fit" | "actual">("fit");

  if (unavailable) {
    return <PosterUnavailable />;
  }

  return (
    <div className="space-y-3">
      <Dialog onOpenChange={(open) => { if (!open) setZoomMode("fit"); }}>
        <figure className="pharos-card-shell overflow-hidden">
          <DialogTrigger asChild>
            <button
              type="button"
              className="pharos-focus-ring group relative block w-full cursor-zoom-in text-left"
              aria-label="Open full-size Safety Score Map lightbox"
            >
              {/* Served by a Pages Function out of KV, so `next/image` has nothing to resolve at build time. */}
              <img
                ref={checkAlreadyFailed}
                src={POSTER_PATH}
                alt={POSTER_ALT}
                width={POSTER_WIDTH}
                height={POSTER_HEIGHT}
                className="aspect-video w-full bg-[#05070d] object-contain"
                onError={onError}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-full border border-white/20 bg-black/75 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm transition-opacity group-hover:bg-black/90"
              >
                <ZoomIn className="h-3.5 w-3.5" />
                <span>Inspect full size</span>
              </span>
            </button>
          </DialogTrigger>
        </figure>

        <DialogContent className="sm:max-w-[95vw] lg:max-w-7xl p-4 sm:p-6">
          <DialogHeader className="pr-10">
            <DialogTitle>Safety Score Map</DialogTitle>
            <DialogDescription>
              Full-resolution render ({POSTER_WIDTH}&nbsp;&times;&nbsp;{POSTER_HEIGHT} PNG). Switch to 100% zoom to pan across smaller grade rings.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div role="group" aria-label="Map zoom level" className="pharos-segmented">
              <button
                type="button"
                aria-pressed={zoomMode === "fit"}
                onClick={() => setZoomMode("fit")}
                className="pharos-focus-ring pharos-segmented-item min-h-11 sm:min-h-8"
              >
                Fit window
              </button>
              <button
                type="button"
                aria-pressed={zoomMode === "actual"}
                onClick={() => setZoomMode("actual")}
                className="pharos-focus-ring pharos-segmented-item min-h-11 sm:min-h-8"
              >
                100% detail
              </button>
            </div>
            <a
              href={POSTER_PATH}
              download={POSTER_FILENAME}
              className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/60 sm:min-h-8 sm:py-1.5"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              Download PNG
            </a>
          </div>

          <div className="overflow-auto rounded-lg border border-border bg-[#05070d]">
            <img
              src={POSTER_PATH}
              alt={POSTER_ALT}
              width={POSTER_WIDTH}
              height={POSTER_HEIGHT}
              className={cn(
                "block bg-[#05070d]",
                zoomMode === "fit"
                  ? "h-auto max-h-[70dvh] w-full object-contain"
                  : "h-auto w-[1600px] max-w-none sm:w-[2200px]",
              )}
            />
          </div>
        </DialogContent>
      </Dialog>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-xs text-muted-foreground">
          Pipeline gap assets have no score or grade and are not placed in A–F bands. Rated partial cards remain mapped;
          see each card&apos;s evidence labels on the Safety Scores page for excluded inputs and priced unknowns.
        </p>
        <a
          href={POSTER_PATH}
          download={POSTER_FILENAME}
          className="pharos-focus-ring inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60 sm:min-h-9"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Download poster (PNG, {POSTER_WIDTH}&nbsp;&times;&nbsp;{POSTER_HEIGHT})
        </a>
      </div>
    </div>
  );
}
