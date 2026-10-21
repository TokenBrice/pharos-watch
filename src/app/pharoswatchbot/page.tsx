import type { Metadata } from "next";
import { FaqSection } from "@/components/faq-section";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { JsonLdScript } from "@/components/json-ld-script";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { TRACKED_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TELEGRAM_FAQ, TELEGRAM_PAGE_DESCRIPTION } from "./telegram-content";
import { buildTelegramPageJsonLd } from "./telegram-json-ld";
import { InstrumentPanel } from "./instrument-panel";
import { AlertFamilies } from "./alert-families";
import {
  AlertControls,
  CommandReference,
  FinalCta,
  GettingStarted,
  MiniAppShowcase,
  PrimaryActions,
  TelegramChannels,
} from "./landing-sections";

export const metadata: Metadata = buildPageMetadata({
  title: "PharosWatchBot: Stablecoin Telegram Alerts",
  description: TELEGRAM_PAGE_DESCRIPTION,
  canonical: "/pharoswatchbot/",
  ogImage: `${SITE_URL}/og-pharoswatchbot.png`,
});

/**
 * Product page for the Telegram bot on the shared feature-page shell: pitch and
 * CTAs → live adoption hero → alert families with verbatim previews → setup →
 * low-noise controls → Mini App → channels → command card → FAQ (incl.
 * reliability and privacy) → closing CTA.
 */
export default function PharosWatchBotPage() {
  return (
    <FeaturePageShell
      breadcrumbName="PharosWatchBot"
      path="/pharoswatchbot/"
      title="PharosWatchBot"
      leadParagraphs={[
        `Stablecoin risk alerts in your Telegram chat, free for all ${TRACKED_STABLECOIN_COUNT.toLocaleString("en-US")} tracked stablecoins. Five alert types watch every peg. Urgent moves arrive live; smaller ones wait for one daily message.`,
      ]}
      headerSupplement={<PrimaryActions />}
    >
      <InstrumentPanel />
      <AlertFamilies />
      <GettingStarted />
      <AlertControls />
      <MiniAppShowcase />
      <TelegramChannels />
      <CommandReference />
      <FaqSection items={TELEGRAM_FAQ} title="Frequently asked questions" includeJsonLd />
      <FinalCta />
      <JsonLdScript json={safeJsonLd(buildTelegramPageJsonLd(SITE_URL))} />
    </FeaturePageShell>
  );
}
