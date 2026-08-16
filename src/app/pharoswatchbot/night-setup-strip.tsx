import { ArrowRight, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import { TelegramAdoptionLink } from "./telegram-adoption-link";
import {
  MINI_APP_SETUP_DEEP_LINK,
  RECOMMENDED_SETUP_COMMAND,
  RECOMMENDED_SETUP_DEEP_LINK,
} from "@/lib/telegram-route-constants";

const WATCH_ORDERS = [
  {
    step: "01",
    title: "Open @PharosWatchBot",
    detail: "Telegram opens the private setup flow. A group works too, but group mutations require an admin.",
  },
  {
    step: "02",
    title: "Approve the low-noise default",
    detail:
      "DEWS and depeg alerts for the current top 25 USD stablecoins. Preset membership updates as the market changes.",
  },
  {
    step: "03",
    title: "Check and adjust",
    detail: "/list audits effective follows, /health diagnoses delivery, /set or the Mini App tunes thresholds.",
  },
] as const;

/**
 * The two-minute enlistment, placed right after the signals so the action
 * path stays close to the pitch. Keeps the #getting-started anchor the HowTo
 * JSON-LD points at.
 */
export function NightSetupStrip() {
  return (
    <section id="getting-started" className="pharos-night-deep scroll-mt-20" aria-labelledby="setup-title">
      <div className="mx-auto max-w-6xl px-4 pb-16 sm:pb-24 lg:px-5 xl:px-9">
        <div className="rounded-2xl border border-border/60 bg-card/50 p-6 sm:p-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
            <h2 id="setup-title" className="text-lg font-semibold text-foreground">
              Start in two minutes
            </h2>
            <p className="text-sm text-muted-foreground">One useful default now; tune only when you need to.</p>
          </div>
          <ol className="mt-6 grid gap-6 sm:grid-cols-3 sm:gap-8">
            {WATCH_ORDERS.map((order) => (
              <li key={order.step} className="border-t border-border/55 pt-4">
                <p className="pharos-numeric text-xs font-semibold text-muted-foreground">{order.step}</p>
                <p className="mt-2 text-sm font-semibold text-foreground">{order.title}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{order.detail}</p>
              </li>
            ))}
          </ol>
          <div className="mt-6 flex flex-col gap-4 border-t border-border/55 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/70 px-2 py-1.5 sm:max-w-md sm:flex-1">
              <code className="block min-w-0 flex-1 whitespace-pre-wrap px-1 font-mono text-xs text-foreground [overflow-wrap:anywhere]">
                {RECOMMENDED_SETUP_COMMAND}
              </code>
              <CopyButton
                text={RECOMMENDED_SETUP_COMMAND}
                className="size-11 shrink-0 text-muted-foreground hover:bg-muted hover:text-foreground"
              />
            </div>
            <div className="flex flex-wrap gap-2.5">
              <Button asChild size="sm" className="gap-2">
                <TelegramAdoptionLink
                  href={RECOMMENDED_SETUP_DEEP_LINK}
                  placement="setup"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Use recommended setup
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </TelegramAdoptionLink>
              </Button>
              <Button asChild variant="outline" size="sm" className="gap-2 bg-transparent">
                <TelegramAdoptionLink
                  href={MINI_APP_SETUP_DEEP_LINK}
                  placement="miniapp_setup"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Smartphone className="h-4 w-4" aria-hidden="true" />
                  Set up in the Mini App
                </TelegramAdoptionLink>
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
