import type { Metadata } from "next";
import { PharosWatchBotMiniAppClient } from "./client";

export const metadata: Metadata = {
  title: "PharosWatchBot Control Panel",
  description: "Telegram Mini App control panel for PharosWatchBot alert settings.",
  robots: { index: false, follow: false },
};

export default function PharosWatchBotMiniAppPage() {
  return <PharosWatchBotMiniAppClient />;
}
