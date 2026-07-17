import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import "./night-watch.css";
import { TELEGRAM_PAGE_DESCRIPTION } from "./telegram-content";
import { buildTelegramPageJsonLd } from "./telegram-json-ld";
import { NightWatchHero } from "./night-watch-hero";
import { NightProgressNav } from "./night-progress-nav";
import { NightSignalsTimeline } from "./night-signals-timeline";
import { NightSetupStrip } from "./night-setup-strip";
import { InstrumentPanel } from "./instrument-panel";
import { ControlDeck } from "./control-deck";
import { DawnRecap } from "./dawn-recap";
import { FieldManual } from "./field-manual";

export const metadata: Metadata = buildPageMetadata({
  title: "PharosWatchBot: Stablecoin Telegram Alerts",
  description: TELEGRAM_PAGE_DESCRIPTION,
  canonical: "/pharoswatchbot/",
  ogImage: `${SITE_URL}/og-pharoswatchbot.png`,
});

/**
 * One night of alerts, dusk to dawn. The wrapper escapes the shell padding
 * for a full-bleed scene and follows the site theme: dark theme renders the
 * night world, light theme the same scene as day (the page-scoped ladder and
 * scene variables in night-watch.css switch on `.dark`). Acts: hero (22:04) →
 * alert examples (23:47) → setup → live adoption (02:13) → Mini App (05:40)
 * → daily recap (08:05) → reference.
 */
export default function PharosWatchBotPage() {
  return (
    <div className="pharos-night -mx-4 -mt-6 md:-mt-7 lg:-mx-5 xl:-mx-9 -mb-6 md:-mb-7">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "PharosWatchBot", url: "/pharoswatchbot/" },
        ]}
      />
      <NightWatchHero />
      <NightProgressNav />
      <NightSignalsTimeline />
      <NightSetupStrip />
      <InstrumentPanel />
      <ControlDeck />
      <DawnRecap />
      <FieldManual />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(buildTelegramPageJsonLd(SITE_URL)) }}
      />
    </div>
  );
}
