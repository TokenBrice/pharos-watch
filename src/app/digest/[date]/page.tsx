import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { JsonLdScript } from "@/components/json-ld-script";
import { DigestSnapshot } from "@/components/digest-snapshot";
import { EditorialColophon } from "@/components/editorial-colophon";
import { PreferredSourcePrompt } from "@/components/preferred-source-prompt";
import { EditorialMasthead } from "@/components/editorial-masthead";
import { splitDigestParagraphs, EDITORIAL_BODY_STYLE, formatDigestDateLabel, parseDigestParagraph } from "@/lib/digest";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { digestDisplay } from "@/lib/fonts/digest";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata, summarizeText, trimTextAtWordBoundary } from "@/lib/page-metadata";
import { createStaticSlugRoute } from "@/lib/static-slug-page";
import { formatIsoTimestamp } from "@shared/lib/format";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import type { DigestContentEntry } from "@shared/types";
import { DIGEST_BY_DATE, DIGEST_ENTRIES } from "@/lib/digest-registry";

const DIGEST_RESEARCH_LINKS = [
  {
    href: "/stability-index/",
    label: "Pharos Stability Index",
    description: "Market-regime context behind the digest's PSI references.",
  },
  {
    href: "/depeg/",
    label: "Depeg tracker",
    description: "Active and resolved peg events that feed daily and weekly recaps.",
  },
  {
    href: "/flows/",
    label: "Mint/burn flows",
    description: "Supply pressure and Bank Run Gauge inputs behind the archive.",
  },
  {
    href: "/safety-scores/",
    label: "Safety scores",
    description: "Current report-card grades and stress-test context for mentioned stablecoins.",
  },
] as const;

function formatDate(dateStr: string): string {
  return formatDigestDateLabel(dateStr, "long");
}

function buildDigestMetadataDescription(digest: DigestContentEntry, formattedDate: string): string {
  const summary = summarizeText(digest.text, 150);
  if (summary.length >= 110) return summary;

  const edition = digest.digestType === "weekly" ? "weekly recap" : "daily brief";
  return trimTextAtWordBoundary(
    `${summary} Read the Pharos ${edition} for ${formattedDate}: PSI, depegs, flows, liquidity, and stablecoin risk signals.`,
    160,
  );
}

function renderDigestDetail(digest: DigestContentEntry) {
  const formatted = formatDate(digest.date);
  const extendedParagraphs = splitDigestParagraphs(digest.extended);
  const isWeekly = digest.digestType === "weekly";
  const editionLabel = isWeekly ? "Weekly Recap" : "Daily Digest";
  const editionKicker = digest.editionNumber ? `${editionLabel} #${digest.editionNumber}` : editionLabel;

  // Find prev/next digests
  const idx = DIGEST_ENTRIES.findIndex((d) => d.date === digest.date);
  const newer = idx > 0 ? DIGEST_ENTRIES[idx - 1] : null;
  const older = idx < DIGEST_ENTRIES.length - 1 ? DIGEST_ENTRIES[idx + 1] : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Digest", url: "/digest/" },
          { name: `${isWeekly ? "Weekly Recap" : "Daily Digest"}: ${formatted}`, url: `/digest/${digest.date}/` },
        ]}
      />
      <JsonLdScript
        json={safeJsonLd(
            buildArticleJsonLd({
              headline: `${digest.title} (${formatted})`,
              description: buildDigestMetadataDescription(digest, formatted),
              image: [`${SITE_URL}/og-editorial-digest.png`],
              datePublished: formatIsoTimestamp(digest.generatedAt),
              dateModified: formatIsoTimestamp(digest.generatedAt),
              mainEntityOfPage: `${SITE_URL}/digest/${digest.date}/`,
            }),
          )}
      />
      <EditorialMasthead date={formatted} editor="Claude Opus 4.8" />
      <div className="space-y-2">
        <p className="pharos-kicker">{editionKicker}</p>
        <h1
          className={`${digestDisplay.className} text-[clamp(2.2rem,5vw,3.5rem)] font-semibold leading-[0.92] tracking-[-0.04em] text-foreground/98 [text-wrap:balance]`}
        >
          {digest.title}
        </h1>
      </div>

      <article className="space-y-6">
        <div className="pharos-card-shell rounded-[1.5rem] px-5 py-5">
          <p className="pharos-kicker">Executive Summary</p>
          <p className="mt-3 text-[1.1rem] leading-8 text-foreground/92" style={EDITORIAL_BODY_STYLE}>
            {digest.text}
          </p>
        </div>

        <div className="mx-auto max-w-[68ch] space-y-4">
          {extendedParagraphs.map((para, i) => {
            const { headerText, bodyText } = parseDigestParagraph(para);
            return (
              <p key={i} className="text-[1.05rem] leading-8 text-foreground/92" style={EDITORIAL_BODY_STYLE}>
                {headerText && <span className="font-semibold tracking-wide">{headerText}. </span>}
                {bodyText}
              </p>
            );
          })}
        </div>
      </article>

      <DigestSnapshot date={digest.date} />

      <section aria-labelledby="digest-research-links" className="space-y-3 border-t border-border/50 pt-5">
        <div className="space-y-1">
          <p className="pharos-kicker">Research Context</p>
          <h2 id="digest-research-links" className="text-base font-semibold text-foreground">
            Follow the signals behind this {isWeekly ? "weekly recap" : "daily digest"}
          </h2>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {DIGEST_RESEARCH_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="pharos-focus-ring group block rounded-lg border border-border/60 bg-background/55 px-3 py-3 transition-colors hover:bg-accent"
            >
              <p className="text-sm font-semibold text-foreground transition-colors group-hover:text-frost-blue">
                {link.label}
              </p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{link.description}</p>
            </Link>
          ))}
        </div>
      </section>

      <nav
        aria-label="Digest navigation"
        className="flex items-center justify-between pt-4 border-t border-border/50 text-sm"
      >
        {older ? (
          <Link
            href={`/digest/${older.date}/`}
            aria-label={`Older digest: ${formatDate(older.date)}`}
            className="pharos-focus-ring text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; {formatDate(older.date)}
          </Link>
        ) : (
          <span />
        )}
        {newer ? (
          <Link
            href={`/digest/${newer.date}/`}
            aria-label={`Newer digest: ${formatDate(newer.date)}`}
            className="pharos-focus-ring text-muted-foreground hover:text-foreground transition-colors"
          >
            {formatDate(newer.date)} &rarr;
          </Link>
        ) : (
          <span />
        )}
      </nav>

      <PreferredSourcePrompt />

      <EditorialColophon
        productionNote={
          isWeekly
            ? "Weekly recap composed from the week's tracked events and DEWS history; scores reflect data available at publication."
            : "Daily digest composed from the day's tracked events and DEWS history; scores reflect data available at publication."
        }
        methodologyVersion={SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}
        citation={{
          title: `${digest.title} (${formatted})`,
          canonicalUrl: `${SITE_URL}/digest/${digest.date}/`,
          accessedDate: digest.date,
        }}
      />
    </div>
  );
}

const route = createStaticSlugRoute({
  paramKey: "date",
  pages: DIGEST_ENTRIES,
  pageBySlug: DIGEST_BY_DATE,
  getSlug: (digest) => digest.date,
  metadata: (digest) => {
    const formatted = formatDate(digest.date);
    return buildPageMetadata({
      title: `${digest.title} (${formatted})`,
      description: buildDigestMetadataDescription(digest, formatted),
      canonical: `/digest/${digest.date}/`,
      ogImage: "/og-editorial-digest.png",
      ogType: "article",
      publishedTime: formatIsoTimestamp(digest.generatedAt),
    });
  },
  missingMetadata: { title: "Digest Not Found", robots: { index: false } },
  render: renderDigestDetail,
});

export const generateStaticParams = route.generateStaticParams;
export const generateMetadata = route.generateMetadata;
export default route.Page;
