"use client";

import { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { TelegramAdoptionLink } from "./telegram-adoption-link";
import { SETUP_DEEP_LINK } from "./telegram-route-constants";

const NIGHT_ACTS = [
  { id: "watch", time: "22:04", label: "Overview" },
  { id: "signals", time: "23:47", label: "Alert examples" },
  { id: "panel", time: "02:13", label: "Live adoption" },
  { id: "control", time: "05:40", label: "Mini App" },
  { id: "dawn", time: "08:05", label: "Daily recap" },
  { id: "manual", time: null, label: "Reference" },
] as const;

/**
 * The section rail pinned under the global nav: timestamped anchor links for
 * each act, a frost progress fill tracking the scroll, and a persistent
 * "Open the bot" CTA once the hero is behind you. Fixes the old page's
 * 7,000px scroll with no quick-nav.
 */
export function NightProgressNav() {
  const [activeAct, setActiveAct] = useState<string>("watch");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const root = document.documentElement;
      const scrollable = root.scrollHeight - root.clientHeight;
      setProgress(scrollable > 0 ? Math.min(1, Math.max(0, root.scrollTop / scrollable)) : 0);
    };
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  useEffect(() => {
    if (typeof window.IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveAct(entry.target.id);
        }
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    for (const act of NIGHT_ACTS) {
      const section = document.getElementById(act.id);
      if (section) observer.observe(section);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <div className="pharos-night-nav sticky top-14 z-30 border-b border-border/40 backdrop-blur-md">
      <div className="mx-auto flex h-11 max-w-6xl items-center gap-2 px-4 lg:px-5 xl:px-9">
        <nav aria-label="Page sections" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {NIGHT_ACTS.map((act) => {
            const isActive = activeAct === act.id;
            return (
              <a
                key={act.id}
                href={`#${act.id}`}
                aria-current={isActive ? "location" : undefined}
                className={cn(
                  "pharos-focus-ring flex shrink-0 items-baseline gap-1.5 rounded-sm px-2 py-1 text-xs transition-colors",
                  isActive ? "text-foreground" : "text-muted-foreground/70 hover:text-muted-foreground",
                )}
              >
                <span className={cn("pharos-numeric", isActive ? "text-frost-blue" : "")}>{act.time ?? "§"}</span>
                <span className="hidden md:inline">{act.label}</span>
              </a>
            );
          })}
        </nav>
        {activeAct !== "watch" ? (
          <TelegramAdoptionLink
            href={SETUP_DEEP_LINK}
            placement="hero"
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Bot className="h-3.5 w-3.5" aria-hidden="true" />
            Open the bot
          </TelegramAdoptionLink>
        ) : null}
      </div>
      <div className="pharos-night-progress-track" aria-hidden="true">
        <div className="pharos-night-progress-fill" style={{ transform: `scaleX(${progress})` }} />
      </div>
    </div>
  );
}
