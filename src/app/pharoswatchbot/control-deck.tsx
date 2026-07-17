import { ArrowRight, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TelegramAdoptionLink } from "./telegram-adoption-link";
import { MiniAppScreenshotCarousel } from "./mini-app-screenshot-carousel";
import { MINI_APP_FEATURES, MINI_APP_SCREENSHOTS } from "./telegram-content";
import { MINI_APP_HOME_DEEP_LINK, MINI_APP_WATCHLIST_DEEP_LINK } from "./telegram-route-constants";

/**
 * Act IV — 05:40, the Mini App. The same alert state without slash commands,
 * staged in the dark theatre with all eleven controls indexed — none hidden
 * behind disclosure.
 */
export function ControlDeck() {
  return (
    <section id="control" className="pharos-night-deep scroll-mt-20" aria-labelledby="control-title">
      <div className="mx-auto max-w-6xl px-4 py-16 sm:py-24 lg:px-5 xl:px-9">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.72fr)] lg:items-start lg:gap-14">
          <div>
            <h2 id="control-title" className="pharos-display text-foreground">
              The same alert state, without slash commands
            </h2>
            <p className="pharos-lead mt-3 max-w-2xl">
              The Mini App is the same alert state without slash commands — watchlist, presets, quiet hours, snooze,
              delivery health. Deep reads like <code>/why</code>, <code>/brief</code>, and <code>/top</code> stay in
              chat.
            </p>
            <ol className="mt-8 grid gap-x-8 sm:grid-cols-2">
              {MINI_APP_FEATURES.map((feature, index) => (
                <li key={feature.title} className="border-t border-border/55 py-3.5">
                  <p className="flex items-baseline gap-2.5">
                    <span aria-hidden="true" className="pharos-numeric text-[11px] text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className="text-sm font-semibold text-foreground">{feature.title}</span>
                  </p>
                  <p className="mt-1 pl-6 text-xs leading-relaxed text-muted-foreground">{feature.detail}</p>
                </li>
              ))}
            </ol>
            <div className="mt-7 flex flex-wrap gap-2.5">
              <Button asChild className="gap-2">
                <TelegramAdoptionLink
                  href={MINI_APP_HOME_DEEP_LINK}
                  placement="miniapp_home"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Smartphone className="h-4 w-4" aria-hidden="true" />
                  Open Mini App
                </TelegramAdoptionLink>
              </Button>
              <Button asChild variant="outline" className="gap-2 bg-transparent">
                <TelegramAdoptionLink
                  href={MINI_APP_WATCHLIST_DEEP_LINK}
                  placement="miniapp_watchlist"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open watchlist
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </TelegramAdoptionLink>
              </Button>
            </div>
          </div>
          <MiniAppScreenshotCarousel screenshots={MINI_APP_SCREENSHOTS} />
        </div>
      </div>
    </section>
  );
}
