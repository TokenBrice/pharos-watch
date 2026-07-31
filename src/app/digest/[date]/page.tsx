import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { DigestSnapshot } from "@/components/digest-snapshot";
import { EditorialColophon } from "@/components/editorial-colophon";
import { EditorialMasthead } from "@/components/editorial-masthead";
import { splitDigestParagraphs, EDITORIAL_BODY_STYLE, formatDigestDateLabel, parseDigestParagraph } from "@/lib/digest";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { digestDisplay } from "@/lib/fonts/digest";
import { safeJsonLd } from "@/lib/json-ld";
import { summarizeText, trimTextAtWordBoundary } from "@/lib/page-metadata";
import { INDEXABLE_ROBOTS } from "@/lib/seo-robots";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import type { DigestContentEntry } from "@shared/types";
import digests from "@data/digests.json";

const allDigests = digests as DigestContentEntry[];
const digestByDate = new Map(allDigests.map((d) => [d.date, d]));

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

export function generateStaticParams() {
  return allDigests.map((d) => ({ date: d.date }));
}

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

export async function generateMetadata({ params }: { params: Promise<{ date: string }> }): Promise<Metadata> {
  const { date } = await params;
  const digest = digestByDate.get(date);
  if (!digest) {
    return {
      title: "Digest Not Found",
      robots: { index: false },
    };
  }
  const formatted = formatDate(digest.date);
  const description = buildDigestMetadataDescription(digest, formatted);
  return {
    title: `${digest.title} (${formatted})`,
    description,
    alternates: { canonical: `/digest/${digest.date}/` },
    robots: INDEXABLE_ROBOTS,
    openGraph: {
      title: `${digest.title} (${formatted}) | Pharos`,
      description,
      url: `/digest/${digest.date}/`,
      type: "article",
      publishedTime: new Date(digest.generatedAt * 1000).toISOString(),
      images: [{ url: "/og-editorial-digest.png", width: 1200, height: 628 }],
    },
    twitter: {
      images: [{ url: "/og-editorial-digest.png", width: 1200, height: 628 }],
    },
  };
}

export default async function DigestDetailPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params;
  const digest = digestByDate.get(date);
  if (!digest) notFound();

  const formatted = formatDate(digest.date);
  const extendedParagraphs = splitDigestParagraphs(digest.extended);
  const isWeekly = digest.digestType === "weekly";
  const editionLabel = isWeekly ? "Weekly Recap" : "Daily Digest";
  const editionKicker = digest.editionNumber ? `${editionLabel} #${digest.editionNumber}` : editionLabel;

  // Find prev/next digests
  const idx = allDigests.findIndex((d) => d.date === digest.date);
  const newer = idx > 0 ? allDigests[idx - 1] : null;
  const older = idx < allDigests.length - 1 ? allDigests[idx + 1] : null;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Digest", url: "/digest/" },
          { name: `${isWeekly ? "Weekly Recap" : "Daily Digest"}: ${formatted}`, url: `/digest/${digest.date}/` },
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd({
            "@context": "https://schema.org",
            "@type": "Article",
            headline: `${digest.title} (${formatted})`,
            image: [`${SITE_URL}/og-editorial-digest.png`],
            datePublished: new Date(digest.generatedAt * 1000).toISOString(),
            dateModified: new Date(digest.generatedAt * 1000).toISOString(),
            description: buildDigestMetadataDescription(digest, formatted),
            author: {
              "@type": "Organization",
              name: "Pharos",
              url: SITE_URL,
            },
            publisher: {
              "@type": "Organization",
              name: "Pharos",
              url: SITE_URL,
              logo: `${SITE_URL}/pharos-mark.png`,
            },
            mainEntityOfPage: `${SITE_URL}/digest/${digest.date}/`,
          }),
        }}
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
