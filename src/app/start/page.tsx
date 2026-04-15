import { StartHerePage } from "@/components/start-here-page";
import { StartHereVisitMarker } from "@/components/start-here-visit-marker";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";

export const metadata = buildPageMetadata({
  title: "Start Here: How to Use Pharos",
  description:
    "New to Pharos? Learn what the main stablecoin signals mean, choose the right feature for your goal, and find the fastest path into market monitoring, research, yield, and alerts.",
  canonical: "/start/",
  ogImage: `${SITE_URL}/og-start.png`,
});

export default function StartPage() {
  return (
    <>
      <StartHereVisitMarker />
      <StartHerePage />
    </>
  );
}
