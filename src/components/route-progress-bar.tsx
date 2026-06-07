"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * 2px frost-blue progress bar pinned to the top of the viewport. Animates on
 * Next.js route navigation: starts on pathname change, ramps to 70%, completes
 * to 100% and fades out once the new route is mounted.
 *
 * `useSearchParams()` was intentionally avoided here — under `output: "export"`
 * it forces the entire route tree to bail out of static rendering. The pathname
 * change is sufficient to detect navigation; query-string-only changes (e.g.
 * filter updates) don't ramp the bar.
 *
 * Z-index 59 sits just below the `RegimeBar` (`z-60`) so it never overlaps.
 */
export function RouteProgressBar() {
  const pathname = usePathname();
  const [progress, setProgress] = useState(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setActive(true);
      setProgress(70);
    });
    const ramp = setTimeout(() => {
      setProgress(100);
    }, 100);
    const fade = setTimeout(() => {
      setActive(false);
      setProgress(0);
    }, 300);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(ramp);
      clearTimeout(fade);
    };
  }, [pathname]);

  return (
    <div
      role="progressbar"
      aria-label="Page loading progress"
      aria-hidden={!active}
      aria-valuenow={active ? progress : undefined}
      aria-valuemin={0}
      aria-valuemax={100}
      className="pointer-events-none fixed left-0 right-0 top-0 z-[59] h-[2px]"
    >
      <div
        className="h-full w-full origin-left bg-primary transition-[transform,opacity] duration-300 ease-out will-change-transform motion-reduce:transition-none"
        style={{
          transform: `scaleX(${progress / 100})`,
          opacity: active ? 1 : 0,
        }}
      />
    </div>
  );
}
