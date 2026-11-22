"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { preload } from "react-dom";
import Link from "next/link";
import { ArrowUpRight, Map as MapIcon } from "lucide-react";
import { useImageUnavailable } from "@/hooks/use-image-unavailable";
import { SAFETY_MAP_TEASER_MOBILE_WIDTH } from "@shared/lib/safety-map-artifacts";

const SAFETY_MAP_PATH = "/safety-scores/map/";
const SAFETY_MAP_IMAGE_PATH = "/safety-scores/map.webp";
const SAFETY_MAP_MOBILE_IMAGE_PATH = `/safety-scores/map.webp?w=${SAFETY_MAP_TEASER_MOBILE_WIDTH}`;
const SAFETY_MAP_FALLBACK_IMAGE_PATH = "/safety-scores/map.png";
const SAFETY_MAP_MOBILE_MEDIA = "(max-width: 639px)";
const SAFETY_MAP_DESKTOP_MEDIA = "(min-width: 640px)";

function useSafetyMapImage() {
  const [imagePath, setImagePath] = useState(SAFETY_MAP_IMAGE_PATH);
  const { unavailable, onError } = useImageUnavailable();
  const handleImageError = useCallback(() => {
    if (imagePath === SAFETY_MAP_IMAGE_PATH) {
      setImagePath(SAFETY_MAP_FALLBACK_IMAGE_PATH);
    } else {
      onError();
    }
  }, [imagePath, onError]);
  const checkAlreadyFailed = useCallback((image: HTMLImageElement | null) => {
    // A failed request can settle before hydration attaches the error handler.
    if (image && image.complete && image.naturalWidth === 0) handleImageError();
  }, [handleImageError]);
  return { imagePath, unavailable, handleImageError, checkAlreadyFailed };
}

const SafetyMapImageContext = createContext<ReturnType<typeof useSafetyMapImage> | null>(null);

export function SafetyMapImageProvider({ children }: { children: ReactNode }) {
  return <SafetyMapImageContext.Provider value={useSafetyMapImage()}>{children}</SafetyMapImageContext.Provider>;
}

/** The hero's LCP teaser; its own small module so the server-rendered hero keeps eager JS light. */
export function SafetyMapPreview() {
  const shared = useContext(SafetyMapImageContext);
  const local = useSafetyMapImage();
  const { imagePath, unavailable, handleImageError, checkAlreadyFailed } = shared ?? local;
  const usingWebp = imagePath === SAFETY_MAP_IMAGE_PATH;
  if (!unavailable && usingWebp) {
    // `<picture>` suppresses React 19's un-scoped `<img>` auto-preload so mobile
    // never double-downloads the 800px desktop teaser; emit media-scoped hints instead.
    preload(SAFETY_MAP_MOBILE_IMAGE_PATH, {
      as: "image",
      type: "image/webp",
      media: SAFETY_MAP_MOBILE_MEDIA,
      fetchPriority: "high",
    });
    preload(SAFETY_MAP_IMAGE_PATH, {
      as: "image",
      type: "image/webp",
      media: SAFETY_MAP_DESKTOP_MEDIA,
      fetchPriority: "high",
    });
  }
  return (
    <Link
      href={SAFETY_MAP_PATH}
      className="pharos-focus-ring group flex min-h-48 min-w-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-background/50 transition-colors hover:border-border hover:bg-muted/30"
      aria-label="Open the Safety Score Map"
    >
      <div className="flex min-h-32 flex-1 items-center justify-center overflow-hidden bg-[#05070d]">
        {unavailable ? (
          <div className="flex flex-col items-center gap-2 text-center text-white/80">
            <MapIcon className="h-7 w-7" aria-hidden="true" />
            <span className="pharos-label text-white/60">Full market map</span>
          </div>
        ) : (
          <picture className="block h-full min-h-32 w-full">
            {usingWebp ? (
              <source
                media={SAFETY_MAP_MOBILE_MEDIA}
                srcSet={SAFETY_MAP_MOBILE_IMAGE_PATH}
                type="image/webp"
              />
            ) : null}
            <img
              ref={checkAlreadyFailed}
              src={imagePath}
              alt=""
              width={800}
              height={450}
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="h-full min-h-32 w-full object-cover object-center transition-transform duration-300 group-hover:scale-[1.02]"
              onError={handleImageError}
            />
          </picture>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
        <div className="min-w-0">
          <p className="pharos-label">Safety score map</p>
          <p className="mt-1 truncate text-sm font-medium text-foreground">Explore every grade band</p>
        </div>
        <ArrowUpRight
          className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
          aria-hidden="true"
        />
      </div>
    </Link>
  );
}
