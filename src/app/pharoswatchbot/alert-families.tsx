"use client";

import { useState } from "react";
import { Anchor, Layers, Radar, Rocket, ShieldCheck, Snowflake, type LucideIcon } from "lucide-react";
import { PharosLogo } from "@/components/pharos-logo";
import { cn } from "@/lib/utils";
import { TELEGRAM_PUBLIC_ALERT_SAMPLES } from "@shared/lib/telegram-alert-samples";
import type { TelegramAlertType } from "@shared/types/status";
import { BotSection } from "./bot-section";
import { TELEGRAM_ALERT_EXAMPLES } from "./telegram-content";

const FAMILY_ICONS: Record<TelegramAlertType, LucideIcon> = {
  dews: Radar,
  depeg: Anchor,
  safety: ShieldCheck,
  launch: Rocket,
  reserve: Layers,
  freeze: Snowflake,
};

/**
 * The six alert families beside a live preview of the selected one. Every
 * preview stays in the DOM (inactive ones `hidden`) so all six verbatim,
 * contract-tested messages remain crawlable.
 */
export function AlertFamilies() {
  const [activeKey, setActiveKey] = useState<TelegramAlertType>(TELEGRAM_ALERT_EXAMPLES[0].key);

  return (
    <BotSection
      id="signals"
      kicker="Alert families"
      title="What lands in your chat"
      lead="Six alert families, each firing on its own evidence. Pick one to see the exact message the bot sends."
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-7">
        <div role="group" aria-label="Alert families" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
          {TELEGRAM_ALERT_EXAMPLES.map((alert) => {
            const Icon = FAMILY_ICONS[alert.key];
            const active = alert.key === activeKey;
            return (
              <button
                key={alert.key}
                type="button"
                aria-pressed={active}
                aria-controls={`alert-preview-${alert.key}`}
                onClick={() => setActiveKey(alert.key)}
                className={cn(
                  "pharos-focus-ring flex min-h-11 w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
                  active
                    ? "border-foreground/25 bg-muted/60 text-foreground"
                    : "border-border/60 text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                )}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-foreground">
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium">{alert.label}</span>
                <code className="hidden shrink-0 font-mono text-2xs text-muted-foreground sm:inline">{alert.key}</code>
              </button>
            );
          })}
        </div>

        <div>
          {TELEGRAM_ALERT_EXAMPLES.map((alert) => (
            <div key={alert.key} id={`alert-preview-${alert.key}`} hidden={alert.key !== activeKey}>
              <h3 className="text-sm font-semibold text-foreground">{alert.label}</h3>
              <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">{alert.tagline}</p>
              <figure className="mt-4 rounded-xl border border-border/60 bg-muted/30 p-4">
                <figcaption className="flex items-center gap-2.5 border-b border-border/50 pb-3">
                  <PharosLogo size={28} />
                  <span className="text-sm font-semibold text-foreground">PharosWatchBot</span>
                  <span className="rounded-sm bg-muted px-1.5 py-0.5 text-3xs font-medium uppercase text-muted-foreground">
                    bot
                  </span>
                </figcaption>
                <p className="mt-3 whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">
                  {alert.content}
                </p>
                <div className="mt-3 space-y-1.5" aria-label="Buttons under the alert">
                  {TELEGRAM_PUBLIC_ALERT_SAMPLES[alert.key].buttons.map((row) => (
                    <div key={row.join("|")} className="flex gap-1.5">
                      {row.map((label) => (
                        <span
                          key={label}
                          className="flex-1 rounded-md border border-border/60 bg-background px-2 py-1 text-center text-xs text-foreground"
                        >
                          {label}
                        </span>
                      ))}
                    </div>
                  ))}
                </div>
              </figure>
            </div>
          ))}
          <p className="pharos-meta mt-3">The exact text the bot sends for each family. No mock-ups.</p>
        </div>
      </div>
    </BotSection>
  );
}
