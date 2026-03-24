import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";
import { buildStablecoinUrl } from "@/lib/urls";
import { UpcomingClient } from "@/components/upcoming-client";

export const metadata: Metadata = buildPageMetadata({
  title: "Upcoming Stablecoins: Pre-Launch Tracker",
  description:
    "Browse upcoming stablecoin launches tracked by Pharos. Filter by launch phase, peg type, and backing. From announced to launching soon.",
  canonical: "/upcoming/",
});

export default function UpcomingPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Upcoming Stablecoins"
      path="/upcoming/"
      title="Upcoming Stablecoins"
      leadParagraphs={[
        "Track upcoming launches before they enter the live stablecoin universe, then open any coin for the full pre-launch dossier.",
      ]}
    >
      <UpcomingClient />

      {/* Server-rendered links for SEO crawlability */}
      <nav aria-label="Upcoming stablecoins index" className="sr-only">
        {PRE_LAUNCH_STABLECOINS.map((coin) => (
          <Link key={coin.id} href={buildStablecoinUrl(coin.id)}>
            {coin.name} ({coin.symbol}) — Pre-launch stablecoin
          </Link>
        ))}
      </nav>
    </FeaturePageShell>
  );
}
