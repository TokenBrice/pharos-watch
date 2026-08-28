import Link from "next/link";
import { Bell } from "lucide-react";
import { FaqSection } from "@/components/faq-section";
import { ShareButton } from "@/components/share-button";
import { DepegEventArchive } from "@/app/depeg/depeg-event-archive";
import { DepegContentLoadingState } from "@/app/depeg/loading";
import { createClientFeaturePage } from "@/lib/client-feature-page";
import { buildApiOgImageUrl } from "@/lib/page-metadata";
import { buildPublicDatasetMirrorJsonLd } from "@/lib/analytics-dataset-json-ld";
import { safeJsonLd } from "@/lib/json-ld";
import type { FaqItem } from "@/lib/faq";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { ACTIVE_STABLECOIN_COUNT } from "@/lib/stablecoin-static-data";

const depegDescription = `Track stablecoin depegs across ${ACTIVE_STABLECOIN_COUNT} coins with live peg deviations, DEWS early warnings, active incidents, heatmaps, severity, and history.`;

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
      "A depeg event is triggered when a stablecoin's price deviates from its peg by more than 1% (100 bps) for USD-pegged coins, or 1.5% (150 bps) for non-USD pegs. Pharos opens events immediately only when the primary price input is trusted. Large-cap coins, low-confidence price inputs, and extreme moves go through a two-stage confirmation process: the deviation must persist for at least 15 minutes and then receive same-direction corroboration from CoinGecko or DefiLlama, Binance, supported native-peg quotes, or trusted DEX and challenger-pool data. Opposite-direction evidence rejects the pending incident instead of confirming it.",
  },
] as const satisfies readonly FaqItem[];

function TelegramAlertsHeaderAction() {
  return (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-2 sm:gap-3">
      <div
        role="note"
        className="flex max-w-full items-start gap-2 rounded-lg border border-border/60 bg-card px-3 py-2 text-xs text-muted-foreground sm:text-sm"
      >
        <Bell className="mt-0.5 h-4 w-4 shrink-0" />
        <p className="min-w-0 leading-relaxed lg:whitespace-nowrap">
          Get instant Telegram alerts for depeg events and DEWS threat level changes.{" "}
          <Link
            href="/pharoswatchbot/#bot"
            className="pharos-focus-ring text-foreground underline underline-offset-4 transition-colors hover:text-foreground/80"
          >
            Set up alerts&nbsp;&rarr;
          </Link>
        </p>
      </div>
      <ShareButton ogPath="/api/og/depeg" />
    </div>
  );
}

const route = createClientFeaturePage({
  path: "/depeg/",
  metadata: {
    title: "Depeg Tracker: Live Peg Alerts, DDR & DEWS",
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
    },
    headerActions: <TelegramAlertsHeaderAction />,
    preface: (
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(buildPublicDatasetMirrorJsonLd("depeg-history")) }}
      />
    ),
    leadParagraphs: [
      "A live incident board for stablecoin depegs: confirmed deviations, pending confirmations, and early stress warnings, with forecasts for how each incident should resolve.",
    ],
  },
  afterClient: (
    <>
      <DepegEventArchive />
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </>
  ),
});

export const metadata = route.metadata;
export default route.Page;
