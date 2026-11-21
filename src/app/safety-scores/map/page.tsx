import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";
import { SafetyMapPoster } from "./poster";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Safety Map: All Graded Coins by Tier",
  description:
    "A downloadable poster of every stablecoin Pharos grades, arranged across five A-to-F bands with bubble area tracking circulating supply and fixed markers for smaller assets.",
  canonical: "/safety-scores/map/",
});

const HOW_TO_READ = [
  {
    term: "Five discrete grade bands",
    bullets: [
      "A sits at the center, followed outward by B, C, D, and F.",
      "Each ring is tinted in its Safety Score color and labeled at top center with its letter, score range, and coin count.",
      "Every graded stablecoin appears as its own logo inside a grade-colored ring, reading as a full market census.",
    ],
  },
  {
    term: "Bubble area and size floors",
    bullets: [
      "Bubble area scales with circulating supply above a per-tier minimum threshold.",
      "Smaller assets below their tier threshold share a fixed presence marker so thin-supply coins stay visible.",
      "The bottom-left key lists the exact threshold for each render, and the largest coins display their names and scores.",
    ],
  },
  {
    term: "Orbit position",
    bullets: [
      "Orbit encodes discrete grade band, never a continuous numeric score.",
      "Bands carry both letter labels and distinct colors so classification never relies on color alone.",
    ],
  },
  {
    term: "Corner annotations",
    bullets: [
      "Top right: share of known supply held by A-grade coins.",
      "Bottom left: known supply split by grade band and the per-tier bubble size thresholds.",
      "Bottom right: Pharos Stability Index at render time, methodology version, capture timestamp, graded count, and any held-publication notice.",
    ],
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
      variant="standard"
      methodology={{
        version: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
        changelogPath: SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH,
        docsPath: "/docs/report-cards/",
      }}
      leadParagraphs={[
        "Every graded stablecoin on one canvas: five discrete grade bands from A at the center outward to F, with bubble area scaled to circulating supply.",
      ]}
    >
      <div className="space-y-10">
        <SafetyMapPoster />

        <div className="max-w-4xl space-y-10">
          <section aria-labelledby="safety-map-how-to-read" className="space-y-4">
            <h2 id="safety-map-how-to-read" className="pharos-section-title">
              How to read it
            </h2>
            <dl className="divide-y divide-border/60 border-y border-border/60">
              {HOW_TO_READ.map((entry) => (
                <div
                  key={entry.term}
                  className="grid gap-2 py-4 sm:grid-cols-[15rem_minmax(0,1fr)] sm:gap-6"
                >
                  <dt className="text-sm font-semibold tracking-tight text-foreground">
                    {entry.term}
                  </dt>
                  <dd className="text-sm leading-relaxed text-foreground/85">
                    <ul className="list-disc space-y-1.5 pl-4">
                      {entry.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="safety-map-freshness" className="space-y-3">
            <h2 id="safety-map-freshness" className="pharos-section-title">
              How current it is
            </h2>
            <p className="text-sm leading-relaxed text-foreground/88">
              The poster is rebuilt and republished every day from the same Safety Score dataset that drives the rest
              of the site. The data date is stamped beside the title. Trust that stamp over the day you view the image,
              and re-download when an up-to-date snapshot matters.
            </p>
            <p className="text-sm leading-relaxed text-foreground/88">
              A map summarizes where each coin landed, never why. For pillar-by-pillar reasoning (backing, exit,
              economic control, evidence quality, and any binding cap), open the coin in the{" "}
              <Link href="/safety-scores/" className="pharos-prose-link">
                Safety Scores matrix
              </Link>
              , which provides the accessible, sortable view of every graded asset.
            </p>
            <p className="pharos-meta">
              Scoring rules and grade definitions live in the{" "}
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
            <p className="text-sm leading-relaxed text-foreground/88">
              The poster is free to republish, share, and print. Keep the corner notes intact so the
              methodology version and the data-as-of date travel with the image, and credit Pharos.
            </p>
          </section>
        </div>
      </div>
    </FeaturePageShell>
  );
}
