import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { JsonLdScript } from "@/components/json-ld-script";
import { SeeAlsoFooter } from "@/components/see-also-footer";
import {
  PUBLISHED_FAILURE_SCENARIOS,
  type PublishedFailureScenario,
} from "@/lib/failure-scenario-index";
import { safeJsonLd } from "@/lib/json-ld";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildPageMetadata } from "@/lib/page-metadata";
import { LearnHero } from "../_shared/learn-hero";
import { LearnPageShell } from "../_shared/learn-page-shell";
import { SectionHeading, SectionKicker } from "../_shared/section-primitives";

const HUB_PATH = "/learn/scenarios/";

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Failure Scenarios: How They Could Break",
  description:
    "Curated hypothetical failure paths for selected stablecoins: each step, missing safeguards, who could stop it, and falsifiers. Not a Safety Score input.",
  canonical: HUB_PATH,
});

function formatReviewDate(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp);
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : isoTimestamp.slice(0, 10);
}

function buildFailureScenarioListJsonLd(
  scenarios: readonly PublishedFailureScenario[],
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    "@id": `${SITE_ORIGIN}${HUB_PATH}`,
    name: "Stablecoin Failure Scenarios",
    description:
      "Curated hypothetical stress analyses showing how selected stablecoins could break. Not Safety Score inputs.",
    url: `${SITE_ORIGIN}${HUB_PATH}`,
    numberOfItems: scenarios.length,
    itemListElement: scenarios.map(({ id, scenario }, index) => {
      const url = `${SITE_ORIGIN}${buildStablecoinUrl(id)}#how-it-breaks`;
      return {
        "@type": "ListItem",
        position: index + 1,
        url,
        name: scenario.title,
        item: {
          "@type": "CreativeWork",
          "@id": url,
          name: scenario.title,
          description: scenario.thesis,
          url,
        },
      };
    }),
  };
}

export default function FailureScenariosHub() {
  const latestReviewedMs = PUBLISHED_FAILURE_SCENARIOS.reduce((latest, entry) => {
    const ms = Date.parse(entry.reviewedAt);
    return Number.isFinite(ms) && ms > latest ? ms : latest;
  }, 0);
  const latestReviewedDate = latestReviewedMs > 0 ? new Date(latestReviewedMs).toISOString().slice(0, 10) : null;

  return (
    <LearnPageShell
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Failure Scenarios", url: HUB_PATH },
      ]}
      title="How stablecoins could break"
      subtitle="Curated hypothetical stress analyses for selected stablecoins: each step, the safeguard missing at it, who could stop the path, and the conditions that would invalidate it. These scenarios are hypothetical and are not Safety Score inputs."
      titleClassName="max-w-[24ch]"
    >
      <JsonLdScript json={safeJsonLd(buildFailureScenarioListJsonLd(PUBLISHED_FAILURE_SCENARIOS))} />
      <LearnHero
        beamLabel="Published scenarios"
        beamValue={PUBLISHED_FAILURE_SCENARIOS.length}
        subKicker="Scope & status"
        sub={
          <p className="pharos-meta text-sm">
            Hypothetical stress analyses
            <span aria-hidden="true" className="px-1.5 text-muted-foreground/50">
              ·
            </span>
            Not Safety Score inputs
            {latestReviewedDate ? (
              <>
                <span aria-hidden="true" className="px-1.5 text-muted-foreground/50">
                  ·
                </span>
                Latest review{" "}
                <time dateTime={latestReviewedDate} className="pharos-numeric text-foreground/85">
                  {latestReviewedDate}
                </time>
              </>
            ) : null}
          </p>
        }
        ariaLabel="Failure scenarios archive"
      />
      <section aria-labelledby="failure-scenarios-list-heading" className="space-y-5">
        <div className="space-y-2">
          <SectionKicker>Approved dossiers</SectionKicker>
          <SectionHeading id="failure-scenarios-list-heading">
            Hypothetical failure paths
          </SectionHeading>
          <p className="max-w-[68ch] text-sm leading-relaxed text-muted-foreground">
            Every entry links to the coin&apos;s How it breaks section. Each scenario is maintainer-approved,
            hash-bound to its exact text, and re-verified on a monthly schedule. None is a prediction, an observed
            compromise, or a Safety Score input.
          </p>
        </div>
        {PUBLISHED_FAILURE_SCENARIOS.length === 0 ? (
          <p className="pharos-empty-note px-4 py-3 text-sm text-muted-foreground">
            None published. Approved failure scenarios appear here once maintainer review passes.
          </p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {PUBLISHED_FAILURE_SCENARIOS.map(({ id, coin, scenario, reviewedAt }) => {
              const logoSrc = getLogoSrc(logosById, id);
              const reviewedDate = formatReviewDate(reviewedAt);
              return (
                <Link
                  key={id}
                  href={`${buildStablecoinUrl(id)}#how-it-breaks`}
                  className="pharos-card-shell pharos-interactive-card pharos-focus-ring group flex h-full flex-col p-5"
                >
                  <div className="mb-2.5 flex items-center gap-2.5">
                    {logoSrc ? (
                      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 dark:border-transparent dark:bg-foreground/12 dark:ring-1 dark:ring-border/60">
                        <img
                          src={logoSrc}
                          alt=""
                          aria-hidden="true"
                          width={18}
                          height={18}
                          className="h-[18px] w-[18px] rounded-full object-contain"
                          loading="lazy"
                        />
                      </span>
                    ) : (
                      <span
                        aria-hidden="true"
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/80 text-xs font-bold text-muted-foreground dark:border-transparent dark:bg-muted dark:ring-1 dark:ring-border/60"
                      >
                        {coin.symbol.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="pharos-label text-foreground">{coin.symbol}</span>
                  </div>
                  <h3 className="text-base font-semibold leading-snug text-foreground transition-colors group-hover:text-brand-accent-text">
                    {scenario.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {scenario.thesis}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/40 pt-3 pharos-meta">
                    {scenario.window ? (
                      <>
                        <span>
                          {scenario.window.label}:{" "}
                          <span className="text-foreground/85">{scenario.window.duration}</span>
                        </span>
                        <span aria-hidden="true" className="text-muted-foreground/50">
                          ·
                        </span>
                      </>
                    ) : null}
                    <span className="whitespace-nowrap">
                      Reviewed{" "}
                      <time dateTime={reviewedDate} className="pharos-numeric text-foreground/85">
                        {reviewedDate}
                      </time>
                    </span>
                  </div>
                  <span className="mt-auto inline-flex items-center gap-1 pt-3 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                    Read in dossier
                    <ArrowUpRight
                      className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                      aria-hidden="true"
                    />
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </section>
      <SeeAlsoFooter route={HUB_PATH} />
    </LearnPageShell>
  );
}
