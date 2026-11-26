import type { Metadata } from "next";
import Script from "next/script";
import { API_ORIGIN } from "@shared/lib/runtime-origins";
import { buildPageMetadata } from "@/lib/page-metadata";
import { PharosWatchBotMiniAppClient } from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "PharosWatchBot Control Panel",
  description: "Telegram Mini App control panel for PharosWatchBot alert settings.",
  canonical: "/pharoswatchbot/app/",
  robots: { index: false, follow: false },
});

export default function PharosWatchBotMiniAppPage() {
  return (
    <>
      <link rel="preconnect" href={API_ORIGIN} crossOrigin="anonymous" />
      <link rel="preconnect" href="https://telegram.org" />
      <Script src="https://telegram.org/js/telegram-web-app.js" strategy="afterInteractive" />
      <PharosWatchBotMiniAppClient />
    </>
  );
}
