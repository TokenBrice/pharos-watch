import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildApiOgImageUrl, buildPageMetadata } from "@/lib/page-metadata";
import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { SafetyMapPoster } from "./poster";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Safety Map: All Graded Coins by Tier",
  description:
    "A downloadable poster of every stablecoin Pharos grades, drawn as supply-sized logos inside their A-to-F Safety Score bands and rebuilt daily.",
  canonical: "/safety-scores/map/",
  // The poster itself is served from KV by a Pages Function, so it is not a file
  // in `out/` and cannot be a same-origin og:image. Use the dynamic Safety
  // Scores card the Worker renders instead.
  ogImage: buildApiOgImageUrl(API_PATHS.ogSafetyScores()),
});

const HOW_TO_READ = [
  {
    term: "Each circle is one stablecoin",
    detail:
      "Coins are drawn as their own logo, so the map reads as a census of the market rather than an abstract chart. Every actively graded stablecoin appears exactly once.",
  },
  {
    term: "Circle area is circulating supply",
    detail:
      "Sizing is by area, not diameter, so two coins that look twice the size really do carry twice the supply. A handful of very large issuers dominate the picture — that is the finding, not a drawing artifact.",
  },
  {
    term: "Rows are Safety Score bands",
    detail:
      "Coins are stacked into five bands running A at the top to F at the bottom. Each band carries its own letter and a fixed top-to-bottom order, so the grade never depends on reading the colour alone.",
  },
  {
    term: "The footer carries the provenance",
    detail:
      "Methodology version, the data-as-of timestamp, and the count of tracked coins that are not rated all sit along the bottom edge, so the image stays self-describing once it leaves this page.",
  },
] as const;

export default function SafetyScoreMapPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Safety Map"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Safety Scores", url: "/safety-scores/" },
        { name: "Safety Map", url: "/safety-scores/map/" },
      ]}
      path="/safety-scores/map/"
      title="Safety Score Map"
      variant="longform"
      methodology={{
        version: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
        changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
      }}
      leadParagraphs={[
        "The whole graded stablecoin universe on one page: every coin Pharos rates, sized by circulating supply and sorted into its Safety Score band.",
      ]}
    >
      <div className="space-y-10">
        <SafetyMapPoster />

        <section aria-labelledby="safety-map-how-to-read" className="space-y-4">
          <h2 id="safety-map-how-to-read" className="pharos-section-title">
            How to read it
          </h2>
          <dl className="divide-y divide-border/60 border-y border-border/60">
            {HOW_TO_READ.map((entry) => (
              <div
                key={entry.term}
                className="grid gap-1 py-4 sm:grid-cols-[16rem_minmax(0,1fr)] sm:gap-6"
              >
                <dt className="text-sm font-semibold tracking-tight text-foreground">
                  {entry.term}
                </dt>
                <dd className="text-sm leading-relaxed text-foreground/82 sm:text-[0.95rem]">
                  {entry.detail}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="safety-map-freshness" className="space-y-3">
          <h2 id="safety-map-freshness" className="pharos-section-title">
            How current it is
          </h2>
          <p className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]">
            The poster is rebuilt and republished every day from the same Safety Score data the rest
            of the site reads, so the copy above is always the current census rather than a
            hand-updated snapshot. The date it was rendered from is stamped into the image footer —
            trust that stamp over the day you happen to be looking at it, and re-download rather than
            reusing an old file when the date matters.
          </p>
          <p className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]">
            A map is a summary. It shows where a coin landed, never why. For the pillar-by-pillar
            reasoning behind a grade — backing, exit, economic control, evidence quality, and any
            binding cap — open the coin on the{" "}
            <Link href="/safety-scores/" className="pharos-prose-link">
              Safety Scores page
            </Link>
            , which is also the accessible, sortable form of everything drawn here.
          </p>
          <p className="pharos-meta">
            Scoring rules and the full grade definitions live in the{" "}
            <Link href="/methodology/#safety-scores-methodology" className="pharos-prose-link">
              Safety Scores methodology
            </Link>
            .
          </p>
        </section>

        <section aria-labelledby="safety-map-reuse" className="space-y-3">
          <h2 id="safety-map-reuse" className="pharos-section-title">
            Using the map
          </h2>
          <p className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]">
            The poster is free to republish, share, and print. Keep the footer intact so the
            methodology version and the data-as-of date travel with the image, and credit Pharos.
          </p>
        </section>
      </div>
    </FeaturePageShell>
  );
}
