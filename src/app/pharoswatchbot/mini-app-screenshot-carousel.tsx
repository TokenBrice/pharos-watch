"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { Pause, Play } from "lucide-react";
import { cn } from "@/lib/utils";

interface MiniAppScreenshot {
  title: string;
  src: string;
  alt: string;
  width: number;
  height: number;
}

const ROTATE_MS = 5_000;

export function MiniAppScreenshotCarousel({ screenshots }: { screenshots: readonly MiniAppScreenshot[] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    if (paused || screenshots.length <= 1) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % screenshots.length);
    }, ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [paused, screenshots.length]);

  return (
    <div className="telegram-mini-app-stage flex flex-1 flex-col gap-3">
      <div
        className="telegram-mini-app-carousel flex flex-1 overflow-hidden rounded-2xl border border-border/65"
        aria-label="Mini App screenshots"
      >
        <div
          className="telegram-mini-app-carousel-track flex h-full w-full"
          style={{ transform: `translateX(-${activeIndex * 100}%)` }}
        >
          {screenshots.map((screenshot, idx) => (
            <figure
              key={screenshot.title}
              className="flex min-w-full flex-col bg-[oklch(0.16_0.02_248)]"
            >
              <div className="min-h-0 flex-1 p-3">
                <Image
                  src={screenshot.src}
                  alt={screenshot.alt}
                  width={screenshot.width}
                  height={screenshot.height}
                  loading={screenshot.title === "Home" ? "eager" : "lazy"}
                  sizes="(min-width: 1024px) 340px, (min-width: 640px) 70vw, 88vw"
                  className="mx-auto h-full max-h-[calc(100svh-9rem)] w-auto rounded-xl object-contain lg:max-h-[560px]"
                />
              </div>
              <figcaption className="flex items-baseline gap-2 border-t border-white/8 px-4 py-2.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/65">
                <span className="pharos-numeric text-sky-300">{String(idx + 1).padStart(2, "0")}</span>
                <span aria-hidden="true" className="text-white/25">·</span>
                <span>{screenshot.title}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          type="button"
          aria-label={paused ? "Play Mini App screenshots" : "Pause Mini App screenshots"}
          aria-pressed={paused}
          onClick={() => setPaused((current) => !current)}
          className="pharos-focus-ring inline-flex size-11 shrink-0 items-center justify-center rounded-md border border-border/65 bg-background/70 text-foreground hover:bg-muted/45"
        >
          {paused ? <Play className="h-3.5 w-3.5" aria-hidden="true" /> : <Pause className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
        {screenshots.map((screenshot, idx) => (
          <button
            key={screenshot.title}
            type="button"
            aria-label={`Show ${screenshot.title} screenshot`}
            aria-pressed={activeIndex === idx}
            onClick={() => {
              setActiveIndex(idx);
              setPaused(true);
            }}
            className={cn(
              "pharos-focus-ring pharos-control-pill min-h-11 shrink-0 px-2.5 py-1 text-xs",
              activeIndex === idx ? "pharos-control-pill-active" : "",
            )}
          >
            {screenshot.title}
          </button>
        ))}
      </div>
    </div>
  );
}
