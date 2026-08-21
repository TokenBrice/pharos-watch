"use client";

import { useState } from "react";
import Link from "next/link";
import { Download, ImageOff } from "lucide-react";

/**
 * The poster bytes are served by `functions/safety-scores/map.png.ts` out of KV,
 * not by the static export, so the image cadence is decoupled from Pages
 * deploys. Two states therefore have to look deliberate rather than broken:
 *
 * - a contributor running `npm run dev`, where no Pages Function exists at all;
 * - production after the kill switch, where the Function answers 404.
 *
 * Both surface as an `error` on the `<img>`, which swaps in the panel below
 * instead of leaving a broken-image glyph in the middle of the page.
 */
const POSTER_PATH = "/safety-scores/map.png";
const POSTER_FILENAME = "pharos-safety-score-map.png";

/**
 * The published raster, in real pixels. The generator composes a 1600x900
 * layout and screenshots it at `DEVICE_SCALE = 2`, asserting the result is
 * exactly this size — see `scripts/maintenance/build-safety-score-map.ts`. The
 * `<img>` is sized entirely by CSS below, so these serve as the intrinsic
 * aspect ratio the browser reserves layout space from, and as the figure quoted
 * to the reader on the download control.
 */
const POSTER_WIDTH = 3200;
const POSTER_HEIGHT = 1800;

const POSTER_ALT =
  "The Pharos Stablecoin Safety Map: every graded stablecoin drawn as its own logo, sized by circulating supply, and grouped into five horizontal bands running from the A tier at the top down to the F tier at the bottom. A footer records the methodology version, the data-as-of date, and how many tracked coins are not rated. The same figures are available as a sortable table on the Safety Scores page.";

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
  const [unavailable, setUnavailable] = useState(false);

  if (unavailable) {
    return <PosterUnavailable />;
  }

  return (
    <div className="space-y-3">
      <figure className="pharos-card-shell overflow-hidden">
        {/* Served by a Pages Function out of KV, so `next/image` has nothing to resolve at build time. */}
        <img
          src={POSTER_PATH}
          alt={POSTER_ALT}
          width={POSTER_WIDTH}
          height={POSTER_HEIGHT}
          className="aspect-[16/9] w-full bg-white object-contain"
          onError={() => setUnavailable(true)}
        />
      </figure>
      <a
        href={POSTER_PATH}
        download={POSTER_FILENAME}
        className="pharos-focus-ring inline-flex items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm font-medium text-foreground hover:bg-muted/60"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        Download the poster (PNG, {POSTER_WIDTH}&nbsp;&times;&nbsp;{POSTER_HEIGHT})
      </a>
    </div>
  );
}
