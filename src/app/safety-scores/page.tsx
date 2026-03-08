import dynamic from "next/dynamic";
import Link from "next/link";
import { Bell } from "lucide-react";
import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { Skeleton } from "@/components/ui/skeleton";
import { CalloutBanner } from "@/components/callout-banner";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { FaqSection } from "@/components/faq-section";
import { ShareButton } from "@/components/share-button";
import { buildPageMetadata } from "@/lib/page-metadata";
import type { FaqItem } from "@/lib/faq";
import { buildStablecoinUrl } from "@/lib/urls";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_VERSION_LABEL,
} from "@shared/lib/safety-score-version";

const ReportCardsClient = dynamic(
  () => import("./client").then((m) => ({ default: m.ReportCardsClient })),
  { loading: () => <Skeleton className="h-[400px] w-full rounded-xl" /> },
);

const reportCardsDescription =
  "Transparent stablecoin safety grades and contagion simulation. Five dimensions combined into a single letter grade, plus simulate what happens when a major stablecoin fails.";

export const metadata = buildPageMetadata({
  title: "Safety Scores: Stablecoin Safety Grades",
  description: reportCardsDescription,
  canonical: "/safety-scores/",
  ogImage: "https://api.pharos.watch/api/og/safety-scores",
});

const FAQ_ITEMS = [
  {
    question: "How are stablecoin safety grades calculated?",
    answer:
      "Each stablecoin is scored across five dimensions: peg stability (historical deviation and depeg events), liquidity depth (DEX pool size, volume, and protocol diversity), resilience (collateral quality, custody model, and blacklist capability), decentralization (governance type and chain infrastructure), and dependency risk (exposure to upstream stablecoins). Dimension scores are weighted and combined into a composite 0–100 score, then mapped to a letter grade from A+ to F.",
  },
  {
    question: "What does the contagion simulation show?",
    answer:
      "The contagion simulator models cascading failures in the stablecoin ecosystem. You select a stablecoin to \"fail\" and the simulation traces dependency chains: if stablecoin A uses stablecoin B as collateral, and B fails, A's grade degrades proportionally to its exposure. This reveals hidden systemic risk: which coins look safe in isolation but are fragile under stress.",
  },
] as const satisfies readonly FaqItem[];
const SAFETY_DIRECTORY_COINS = TRACKED_STABLECOINS.slice(0, 12);

export default function ReportCardsPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Safety Scores"
      path="/safety-scores/"
      title="Safety Scores"
      statusBadge={{ status: "mature", version: SAFETY_SCORE_VERSION_LABEL }}
      methodology={{
        version: SAFETY_SCORE_VERSION_LABEL,
        changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
      }}
      headerActions={<ShareButton ogPath="/api/og/safety-scores" />}
      leadParagraphs={[
        "Safety grades and contagion simulation for every tracked stablecoin.",
        "Each stablecoin receives a letter grade from A+ to F based on five dimensions: peg stability, liquidity depth, transparency, resilience, and regulatory standing. The contagion simulator lets you model what happens to the broader market when a major stablecoin fails, revealing hidden dependency chains and systemic risk.",
      ]}
    >
      <CalloutBanner icon={<Bell className="h-4 w-4" />} className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">
        Get notified when a safety grade changes.{" "}
        <a
          href="https://t.me/PharosDigestBot"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground underline underline-offset-4 hover:text-foreground/80 transition-colors"
        >
          Subscribe via @PharosDigestBot&nbsp;&rarr;
        </a>
      </CalloutBanner>

      <section className="space-y-3 rounded-2xl border border-border/60 bg-card/60 px-4 py-4">
        <div className="space-y-1.5">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Most-Followed Safety Profiles
          </h2>
          <p className="text-sm text-muted-foreground">
            Start with the most watched stablecoins, then drop into the live grading grid for the full universe.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {SAFETY_DIRECTORY_COINS.map((coin) => (
            <Link
              key={coin.id}
              href={buildStablecoinUrl(coin.id)}
              className="inline-flex items-center rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent"
            >
              {coin.name} ({coin.symbol})
            </Link>
          ))}
        </div>
      </section>
      <ReportCardsClient />
      <FaqSection items={FAQ_ITEMS} includeJsonLd />
    </FeaturePageShell>
  );
}
