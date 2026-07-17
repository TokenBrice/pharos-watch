"use client";

import Image from "next/image";
import { Anchor, Layers, Radar, Rocket, ShieldCheck, Snowflake, type LucideIcon } from "lucide-react";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { TELEGRAM_ALERT_EXAMPLES } from "./telegram-content";
import type { TelegramAlertType } from "@shared/types/status";

const FAMILY_ICONS: Record<TelegramAlertType, LucideIcon> = {
  dews: Radar,
  depeg: Anchor,
  safety: ShieldCheck,
  launch: Rocket,
  reserve: Layers,
  freeze: Snowflake,
};

type AlertExample = (typeof TELEGRAM_ALERT_EXAMPLES)[number];

/**
 * One signal arrival on the night timeline: a frost node lights on the spine
 * and the card drifts up into place once the row nears the viewport. The
 * message body is the verbatim, contract-tested text the bot sends.
 */
function SignalRow({ alert }: { alert: AlertExample }) {
  const { ref, near } = useNearViewport<HTMLLIElement>("160px");
  const Icon = FAMILY_ICONS[alert.key];

  return (
    <li ref={ref} data-revealed={near} className="relative grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-4">
      <span aria-hidden="true" className="relative">
        <span className="pharos-signal-node absolute left-1/2 top-1.5 size-3 -translate-x-1/2 rounded-full" />
      </span>
      <div className="min-w-0">
        <p className="pharos-numeric text-xs text-muted-foreground">{alert.time} UTC</p>
        <article className="pharos-signal-card mt-2 rounded-xl border border-border/60 bg-card/70 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/60 text-foreground">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <h3 className="text-sm font-semibold text-foreground">{alert.label}</h3>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-muted-foreground">
              {alert.key}
            </code>
          </div>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">{alert.tagline}</p>
          <div className="mt-4 rounded-lg border border-border/50 bg-background/70 p-3">
            <div className="flex items-center gap-2 border-b border-border/40 pb-2">
              <Image src="/pharos-icon.png" alt="" width={20} height={20} className="rounded-full" />
              <span className="text-xs font-medium text-foreground">PharosWatchBot</span>
              <span className="pharos-numeric ml-auto text-[10px] text-muted-foreground">{alert.time}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/90 [overflow-wrap:anywhere]">
              {alert.content}
            </p>
          </div>
        </article>
      </div>
    </li>
  );
}

/**
 * Act II — 23:47, what lands in your chat. The six alert families as a
 * timeline of the night; each card arrives as you scroll past its timestamp.
 */
export function NightSignalsTimeline() {
  return (
    <section id="signals" className="pharos-night-deep scroll-mt-28" aria-labelledby="signals-title">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:py-24 lg:px-5 xl:px-9">
        <div className="max-w-2xl">
          <p className="pharos-numeric text-xs text-muted-foreground">23:47 — a DEWS alert lands</p>
          <h2 id="signals-title" className="pharos-display mt-3 text-foreground">
            What lands in your chat
          </h2>
          <p className="pharos-lead mt-3">
            Six alert families, each firing on its own evidence — and every message below is the exact text the bot
            sends. No mock-ups.
          </p>
        </div>
        <ol className="relative mt-12 space-y-10 sm:mt-16 sm:space-y-14">
          <span aria-hidden="true" className="pharos-signal-spine" />
          {TELEGRAM_ALERT_EXAMPLES.map((alert) => (
            <SignalRow key={alert.key} alert={alert} />
          ))}
        </ol>
      </div>
    </section>
  );
}
