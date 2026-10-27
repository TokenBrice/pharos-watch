import { AlertsHeaderLink } from "@/components/alerts-header-link";
import { FaqSection } from "@/components/faq-section";
import { JsonLdScript } from "@/components/json-ld-script";
import { ShareButton } from "@/components/share-button";
import { DepegEventArchivePreview } from "@/app/depeg/depeg-event-archive";
import { DepegContentLoadingState } from "@/app/depeg/loading-state";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildApiOgImageUrl } from "@/lib/page-metadata";
import { buildPublicDatasetMirrorJsonLd } from "@/lib/analytics-dataset-json-ld";
import { safeJsonLd } from "@/lib/json-ld";
import type { FaqItem } from "@/lib/faq";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { DEPEG_PENDING_MIN_AGE_SEC, DEPEG_THRESHOLD_BPS, DEPEG_THRESHOLD_BPS_NON_USD } from "@shared/lib/depeg-config";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";
import { DEPEG_EVENT_ENTRIES } from "@/lib/depeg-event-page-data";

const depegDescription = `Track stablecoin depegs across ${ACTIVE_STABLECOIN_COUNT} coins: live peg deviations, early warnings, active incidents, recovery forecasts and ${DEPEG_EVENT_ENTRIES.length} recorded depeg events.`;

const FAQ_ITEMS = [
  {
    question: "What is the DEWS score?",
    answer:
      "DEWS (Depeg Early Warning System) is a per-coin stress score from 0 to 100, computed every 30 minutes from 8 sub-signals: supply velocity, pool balance drift, liquidity erosion, price confidence, cross-source divergence, blacklist activity, mint/burn flow, and yield anomaly. It is designed to surface pre-price and live-market stress signals, with scores amplified by up to 30% during periods of broader ecosystem instability (low PSI), plus a bounded same-peg contagion multiplier from current WARNING/DANGER peers (currently 1.08/1.15, capped at 1.2).",
  },
  {
    question: "How is the peg score calculated?",
    answer:
      "The peg score (0–100) combines two equally weighted components: peg percentage (the share of tracked history spent at peg) and severity score (100 minus per-event penalties based on peak deviation magnitude, duration, and recency). An active depeg penalty of up to 50 points and a spread penalty of up to 15 points are subtracted. The score returns null for coins with fewer than 7 days of tracking history, and scores based on 7 to 30 days are labeled Early score.",
  },
  {
    question: "What counts as a depeg event on Pharos?",
    answer:
      `A depeg event is triggered when a stablecoin's price deviates from its peg by more than ${DEPEG_THRESHOLD_BPS / 100}% (${DEPEG_THRESHOLD_BPS} bps) for USD-pegged coins, or ${DEPEG_THRESHOLD_BPS_NON_USD / 100}% (${DEPEG_THRESHOLD_BPS_NON_USD} bps) for non-USD pegs. Every new event is pending at first: the deviation must hold for at least ${DEPEG_PENDING_MIN_AGE_SEC / 60} minutes and be backed by a trusted or multi-source primary price, or by same-direction secondary evidence, before it is confirmed. Opposite-direction evidence never counts as confirmation and can reject a pending event.`,
  },
] as const satisfies readonly FaqItem[];

const route = createClientFeaturePage({
  path: "/depeg/",
  metadata: {
    title: "Stablecoin Depeg Tracker: Live Alerts & History",
    description: depegDescription,
    ogImage: buildApiOgImageUrl(API_PATHS.ogDepeg()),
  },
  loadClient: () => import("./client").then((m) => ({ default: m.DepegClient })),
  loading: <DepegContentLoadingState />,
  shell: {
    breadcrumbName: "Depeg Tracker",
    title: "Depeg Tracker",
    methodology: {
      version: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
      changelogPath: DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
      docsPath: "/docs/depeg-detection/",
    },
    header: "instrument",
    headerActions: (
      <>
        <AlertsHeaderLink
          href="/pharoswatchbot/#bot"
          description="Get instant Telegram alerts for depeg events and DEWS threat level changes"
        />
        <ShareButton ogPath="/api/og/depeg" />
      </>
    ),
    preface: (
      <JsonLdScript json={safeJsonLd(buildPublicDatasetMirrorJsonLd("depeg-history"))} />
    ),
    leadParagraphs: [
      "Live stablecoin depegs, pending confirmations, and early stress warnings, with recovery forecasts.",
    ],
  },
  afterClient: (
    <>
      <DepegEventArchivePreview />
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </>
  ),
});

export const metadata = route.metadata;
export default route.Page;
