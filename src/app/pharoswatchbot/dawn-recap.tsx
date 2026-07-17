import Link from "next/link";
import { ArrowRight, Bot, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import { TelegramAdoptionLink } from "./telegram-adoption-link";
import { LiveWatcherCount } from "./live-watcher-count";
import { SETUP_DEEP_LINK } from "./telegram-route-constants";
import { TELEGRAM_ACTIONS, TELEGRAM_COMMAND_COUNT } from "./telegram-content";

const PROSE_LINK_CLASS =
  "pharos-focus-ring rounded-sm underline underline-offset-4 transition-colors hover:text-foreground";

/**
 * Act V — 08:05, the daily recap. The narrow beam widens into a horizon glow:
 * the night of alerts closes with one morning summary. Social proof here is
 * real numbers only — live or registry — never invented voices.
 */
export function DawnRecap() {
  const secondaryActions = TELEGRAM_ACTIONS.filter((action) => !action.isPrimary);

  return (
    <section id="dawn" className="pharos-night-dawn relative scroll-mt-20 overflow-hidden" aria-labelledby="dawn-title">
      <div aria-hidden="true" className="pharos-night-dawn-glow absolute inset-x-0 bottom-0 h-[420px]" />
      <div className="relative mx-auto max-w-6xl px-4 py-16 sm:py-24 lg:px-5 xl:px-9">
        <div className="max-w-2xl">
          <h2 id="dawn-title" className="pharos-display text-foreground">
            One recap each morning
          </h2>
          <p className="pharos-lead mt-3">
            Set <code>/timezone</code> once, flip <code>/recap on</code>, and the bot sends one private summary of your
            watchlist&rsquo;s material changes each local morning — only when something actually changed. No material
            change, no message.
          </p>
        </div>

        <dl className="mt-10 grid gap-x-8 gap-y-6 border-t border-border/55 pt-6 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <dt className="text-xs text-muted-foreground">Active watchers</dt>
            <dd className="mt-1 text-xl">
              <LiveWatcherCount />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Tracked stablecoins</dt>
            <dd className="pharos-numeric mt-1 text-xl font-semibold text-foreground">
              {TRACKED_STABLECOIN_COUNT.toLocaleString("en-US")}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Alert families</dt>
            <dd className="pharos-numeric mt-1 text-xl font-semibold text-foreground">6</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Bot commands</dt>
            <dd className="pharos-numeric mt-1 text-xl font-semibold text-foreground">{TELEGRAM_COMMAND_COUNT}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Price</dt>
            <dd className="mt-1 text-xl font-semibold text-foreground">Free</dd>
          </div>
        </dl>

        <div className="mt-12 max-w-2xl">
          <h3 className="text-lg font-semibold text-foreground">Start getting alerts.</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Open the bot, approve one preset, and tonight&rsquo;s signals have somewhere to land.
          </p>
          <div className="mt-5">
            <Button asChild size="lg" className="gap-2">
              <TelegramAdoptionLink href={SETUP_DEEP_LINK} placement="hero" target="_blank" rel="noopener noreferrer">
                <Bot className="h-4 w-4" aria-hidden="true" />
                Open the bot
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </TelegramAdoptionLink>
            </Button>
          </div>
        </div>

        <div className="mt-12 grid gap-x-8 sm:grid-cols-2">
          {secondaryActions.map((action) => (
            <div
              key={action.key}
              id={action.key === "digest" ? "channel" : "community"}
              className="scroll-mt-20 border-t border-border/55 py-4"
            >
              <h3 className="text-sm font-semibold text-foreground">{action.title}</h3>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{action.handle}</p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {action.description}
                {action.showArchiveLink ? (
                  <>
                    {" "}
                    <Link href="/digest/" className={PROSE_LINK_CLASS}>
                      Browse archive
                    </Link>
                    .
                  </>
                ) : null}
              </p>
              <a
                href={action.href}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring mt-3 inline-flex min-h-11 items-center gap-1.5 rounded-md text-sm font-medium text-foreground underline underline-offset-4"
              >
                {action.cardButtonLabel}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                <span className="sr-only">(opens in new tab)</span>
              </a>
            </div>
          ))}
        </div>

        <p className="mt-10 text-xs text-muted-foreground">
          Methodology for DEWS, safety-grade, and depeg scoring lives on the{" "}
          <Link href="/methodology/" className={PROSE_LINK_CLASS}>
            methodology page
          </Link>
          <ArrowRight className="ml-1 inline h-3 w-3" aria-hidden="true" />
        </p>
      </div>
    </section>
  );
}
