import type { Metadata } from "next";
import { PreLaunchAlertAction } from "@/components/pre-launch-alert-action";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { ShareButton } from "@/components/share-button";
import { JsonLdScript } from "@/components/json-ld-script";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { LAUNCH_PHASE_LABELS, PRE_LAUNCH_UNPHASED_LABEL } from "@shared/lib/classification/pre-launch";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { UPCOMING_LAUNCH_PHASE_VALUES, type UpcomingLaunchPhase } from "@shared/types/core";
import type { StablecoinMeta } from "@shared/types";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { UpcomingClient } from "@/components/upcoming-client";
import { UpcomingLaunchedSection, UpcomingStaticSections } from "@/components/upcoming-static-sections";
import { buildLatestLaunchNews, buildLaunchedUntrackedRows, buildUpcomingCurrencyGroups } from "@/lib/upcoming-static-content";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";
import { getLogoSrc, logosById } from "@/lib/logos";
import aiSummaries from "@data/ai-summaries.json";

// Server-side teaser selection: only the dozen pre-launch texts reach the
// client instead of the full ai-summaries corpus.
const typedSummaries = aiSummaries as Record<string, { text?: string }>;
const PRE_LAUNCH_TEASERS = Object.fromEntries(
  PRE_LAUNCH_STABLECOINS.flatMap((coin) => {
    const text = typedSummaries[coin.id]?.text;
    return text ? [[coin.id, text]] : [];
  }),
);

// Launched rows are live, not upcoming: they get their own section and count (R7).
const UPCOMING_STABLECOINS = PRE_LAUNCH_STABLECOINS.filter(
  (coin): coin is StablecoinMeta & { launchPhase?: UpcomingLaunchPhase } => !isLaunchedAwaitingData(coin),
);
const LAUNCHED_STABLECOINS = PRE_LAUNCH_STABLECOINS.filter(isLaunchedAwaitingData);

const PRE_LAUNCH_CLIENT_COINS = UPCOMING_STABLECOINS.map((coin) => ({
  id: coin.id,
  name: coin.name,
  symbol: coin.symbol,
  flags: {
    pegCurrency: coin.flags.pegCurrency,
    backing: coin.flags.backing,
    governance: coin.flags.governance,
  },
  launchPhase: coin.launchPhase,
  expectedLaunchDate: coin.expectedLaunchDate,
  announcedDate: coin.announcedDate,
  dateHistory: coin.dateHistory,
  milestones: coin.milestones,
}));

const PRE_LAUNCH_LOGOS = Object.fromEntries(
  PRE_LAUNCH_STABLECOINS.map((coin) => [coin.id, getLogoSrc(logosById, coin.id)]),
);

// The month stamp is the build month: the static export is rebuilt at least
// daily, so it cannot outlive the registry snapshot the count comes from.
const UPCOMING_BUILD_MONTH = new Date().toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
// Coins without a launchPhase have no `UPCOMING_LAUNCH_PHASE_VALUES` bucket,
// so the complement is counted explicitly and the tally covers every coin.
const UPCOMING_UNPHASED_COUNT = UPCOMING_STABLECOINS.filter((coin) => !coin.launchPhase).length;
const UPCOMING_PHASE_TALLY = [
  ...UPCOMING_LAUNCH_PHASE_VALUES
    .map((phase) => [phase, UPCOMING_STABLECOINS.filter((coin) => coin.launchPhase === phase).length] as const)
    .filter(([, count]) => count > 0)
    .map(([phase, count]) => `${LAUNCH_PHASE_LABELS[phase]} ${count}`),
  ...(UPCOMING_UNPHASED_COUNT > 0 ? [`${PRE_LAUNCH_UNPHASED_LABEL} ${UPCOMING_UNPHASED_COUNT}`] : []),
].join(", ");

export const metadata: Metadata = buildPageMetadata({
  title: `Upcoming Stablecoin Launches (${UPCOMING_BUILD_MONTH}): ${UPCOMING_STABLECOINS.length} Tracked`,
  description: `${UPCOMING_STABLECOINS.length} stablecoins announced but not yet live. By phase: ${UPCOMING_PHASE_TALLY}. Targets and sourced milestones.`,
  canonical: "/upcoming/",
  ogImage: `${SITE_URL}/og-upcoming.png`,
});

export default function UpcomingPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Upcoming Stablecoins"
      path="/upcoming/"
      title="Upcoming Stablecoins"
      header="instrument"
      headerActions={(
        <>
          <PreLaunchAlertAction description="Pharos's Telegram channel digest lists the stablecoins Pharos starts tracking" />
          {/* Timeless by decision (docs/og-images.md): the route card carries no registry count. */}
          <ShareButton ogPath={API_PATHS.ogPage("upcoming")} />
        </>
      )}
      leadDisclosureLabel="How to use the tracker"
      preface={(
        <JsonLdScript
          json={safeJsonLd(
              buildCollectionItemListJsonLd({
                url: `${SITE_URL}/upcoming/`,
                name: "Upcoming Stablecoins",
                description: LAUNCHED_STABLECOINS.length > 0
                  ? `${UPCOMING_STABLECOINS.length} upcoming and ${LAUNCHED_STABLECOINS.length} launched, not yet tracked, stablecoins on Pharos.`
                  : `${UPCOMING_STABLECOINS.length} pre-launch stablecoins tracked by Pharos.`,
                entries: PRE_LAUNCH_STABLECOINS.map((coin) => {
                  const url = `${SITE_URL}${buildStablecoinUrl(coin.id)}`;

                  return {
                    item: {
                      "@type": "WebPage",
                      "@id": url,
                      name: `${coin.name} (${coin.symbol})`,
                      url,
                    },
                  };
                }),
              }),
            )}
        />
      )}
      leadParagraphs={[
        "Pre-launch stablecoins Pharos tracks, by phase, target date and slippage.",
        "Coins move to the live universe once Pharos can verify a price and a supply source; launched coins still waiting on one are listed separately. Open any coin for its pre-launch dossier: sourced milestones, target history, and a copy-ready alert command for that asset.",
      ]}
    >
      <UpcomingClient
        coins={PRE_LAUNCH_CLIENT_COINS}
        logos={PRE_LAUNCH_LOGOS}
        teasers={PRE_LAUNCH_TEASERS}
      />

      <UpcomingLaunchedSection rows={buildLaunchedUntrackedRows(LAUNCHED_STABLECOINS)} />

      {/* Server-rendered news and currency groups; the launched section and the groups together link every pre-launch profile. */}
      <UpcomingStaticSections
        news={buildLatestLaunchNews(PRE_LAUNCH_STABLECOINS)}
        groups={buildUpcomingCurrencyGroups(UPCOMING_STABLECOINS)}
      />
    </FeaturePageShell>
  );
}
