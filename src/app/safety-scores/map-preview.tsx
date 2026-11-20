"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Map as MapIcon } from "lucide-react";
import { useImageUnavailable } from "@/hooks/use-image-unavailable";

const SAFETY_MAP_PATH = "/safety-scores/map/";
const SAFETY_MAP_IMAGE_PATH = "/safety-scores/map.webp";
const SAFETY_MAP_FALLBACK_IMAGE_PATH = "/safety-scores/map.png";

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
