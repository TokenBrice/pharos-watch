import type { Metadata } from "next";
import { FaqSection } from "@/components/faq-section";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { JsonLdScript } from "@/components/json-ld-script";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TELEGRAM_COVERAGE_SENTENCE, TELEGRAM_FAQ, TELEGRAM_PAGE_DESCRIPTION } from "./telegram-content";
import { buildTelegramPageJsonLd } from "./telegram-json-ld";
import { InstrumentPanel } from "./instrument-panel";
import { AlertFamilies } from "./alert-families";
import { SubscribeCommandBuilder } from "./subscribe-builder";
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
  title: "Free Stablecoin Depeg Alerts on Telegram | PharosWatchBot",
  titleAbsolute: true,
  description: TELEGRAM_PAGE_DESCRIPTION,
  canonical: "/pharoswatchbot/",
});

/**
 * Product page for the Telegram bot on the shared feature-page shell: pitch,
 * clarified CTAs & inline social-proof chip → above-the-fold verbatim alert
 * previews → Mini App → setup → low-noise controls → group/batch command
 * builder → live adoption telemetry → channels → command card → FAQ → closing CTA.
 */
export default function PharosWatchBotPage() {
  return (
    <FeaturePageShell
      breadcrumbName="PharosWatchBot"
      path="/pharoswatchbot/"
      title="PharosWatchBot"
      leadParagraphs={[TELEGRAM_COVERAGE_SENTENCE]}
      headerSupplement={<PrimaryActions />}
    >
      <AlertFamilies />
      <MiniAppShowcase />
      <GettingStarted />
      <AlertControls />
      <SubscribeCommandBuilder />
      <InstrumentPanel />
      <TelegramChannels />
      <CommandReference />
      <FaqSection items={TELEGRAM_FAQ} title="Frequently asked questions" includeJsonLd />
      <FinalCta />
      <JsonLdScript json={safeJsonLd(buildTelegramPageJsonLd(SITE_URL))} />
    </FeaturePageShell>
  );
}
