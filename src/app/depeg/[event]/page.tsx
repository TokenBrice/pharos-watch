import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { RelatedIncidentsRail } from "@/components/related-incidents-rail";
import { buildPageMetadata } from "@/lib/page-metadata";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import { buildStablecoinUrl } from "@/lib/urls";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";
import { formatDeviationBps, formatIsoDate } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  getDepegDewsMethodologyVersionAt,
} from "@shared/lib/depeg-dews-version";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-version";
import { getCuratedAnnotations } from "@shared/data/annotations/curated-annotations";
import type { ChartAnnotation } from "@shared/types/chart-annotation";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { EDITORIAL_BODY_STYLE, splitDigestParagraphs } from "@/lib/digest";
import { digestDisplay } from "@/lib/fonts/digest";
import {
  DEPEG_EVENT_ENTRIES,
  INDEXABLE_DEPEG_EVENT_SLUGS,
  eventBySlug,
  formatIncidentNumber,
  type DepegEventEntry,
} from "./page-data";
import { getDepegEditorial, qualifiesForEditorialBriefing } from "./editorials";
import { CASE_STUDY_BY_DEPEG_SLUG } from "@/app/learn/case-studies/content";

export function generateStaticParams() {
  return DEPEG_EVENT_ENTRIES.map((event) => ({ event: event.slug }));
}

const CURATED_MATCH_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

interface CuratedMatch {
  label: string;
  href?: string;
  severity?: ChartAnnotation["severity"];
}

function findCuratedAnnotation(event: DepegEventEntry): CuratedMatch | null {
  const annotations = getCuratedAnnotations(event.stablecoinId);
  if (annotations.length === 0) return null;
  const eventMs = event.startedAt * 1000;
  const candidates = annotations
    .filter((annotation) => annotation.kind === "depeg")
    .filter((annotation) => Math.abs(annotation.ts - eventMs) <= CURATED_MATCH_WINDOW_MS);
  if (candidates.length === 0) return null;
  const severityRank: Record<NonNullable<ChartAnnotation["severity"]>, number> = {
    high: 3,
    med: 2,
    low: 1,
  };
  const ranked = [...candidates].sort((a, b) => {
    const aRank = a.severity ? severityRank[a.severity] : 0;
    const bRank = b.severity ? severityRank[b.severity] : 0;
    if (bRank !== aRank) return bRank - aRank;
    return Math.abs(a.ts - eventMs) - Math.abs(b.ts - eventMs);
  });
  const top = ranked[0];
  return { label: top.label, href: top.href, severity: top.severity };
}

function formatLongDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatPrice(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0.01) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function directionLabel(direction: "above" | "below"): string {
  return direction === "below" ? "below peg" : "above peg";
}

function buildHeroTitle(event: DepegEventEntry, coinName: string | null): string {
  const base = coinName ?? event.symbol;
  return `${base} depeg ${directionLabel(event.direction)} — ${formatLongDate(event.startedAt)}`;
}

function buildHeroDescription(event: DepegEventEntry): string {
  const status = event.endedAt ? "Recovered" : "Ongoing";
  const dev = formatDeviationBps(event.peakDeviationBps);
  return `${event.symbol} traded ${directionLabel(event.direction)} with a peak deviation of ${dev} starting ${formatIsoDate(event.startedAt)}. Confirmed ${status.toLowerCase()} depeg event with timeline, severity, recovery, and Pharos methodology context.`;
}

export async function generateMetadata(
  { params }: { params: Promise<{ event: string }> },
): Promise<Metadata> {
  const { event: slug } = await params;
  const event = eventBySlug.get(slug);
  if (!event) {
    return { title: "Depeg Event Not Found", robots: { index: false } };
  }
  const coin = TRACKED_META_BY_ID.get(event.stablecoinId);
  const title = buildHeroTitle(event, coin?.name ?? null);
  const description = buildHeroDescription(event);
  return buildPageMetadata({
    title,
    description,
    canonical: `/depeg/${event.slug}/`,
    ogImage: `${SITE_URL}/og-editorial-depeg.png`,
    robots: INDEXABLE_DEPEG_EVENT_SLUGS.has(event.slug)
      ? undefined
      : { index: false, follow: true },
  });
}

function ProvenanceLine({ event }: { event: DepegEventEntry }) {
  const methodologyVersion = getDepegDewsMethodologyVersionAt(event.startedAt);
  const versionLabel = toMethodologyVersionLabel(methodologyVersion);
  const provenance = event.provenance ?? null;
  const parts: string[] = [`Detected under ${versionLabel}`];
  if (provenance?.confidenceTier) parts.push(`${provenance.confidenceTier} confidence`);
  if (provenance?.auditVerdict) parts.push(`audit: ${provenance.auditVerdict}`);
  if (event.confirmationSources) parts.push(`confirmed via ${event.confirmationSources}`);
  return <p className="text-sm text-muted-foreground">{parts.join(" · ")}</p>;
}

function RecoveryPanel({ event }: { event: DepegEventEntry }) {
  const startPrice = formatPrice(event.startPrice);
  const peakPrice = formatPrice(event.peakPrice);
  const recoveryPrice = formatPrice(event.recoveryPrice);
  const durationSec = event.endedAt ? event.endedAt - event.startedAt : null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Direction</dt>
        <dd className="font-medium text-foreground">{directionLabel(event.direction)}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Peak deviation</dt>
        <dd className="pharos-numeric font-medium text-foreground">{formatDeviationBps(event.peakDeviationBps)}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Started</dt>
        <dd className="pharos-numeric font-medium text-foreground">{formatLongDate(event.startedAt)}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Ended</dt>
        <dd className="pharos-numeric font-medium text-foreground">
          {event.endedAt ? formatLongDate(event.endedAt) : "Ongoing"}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Duration</dt>
        <dd className="pharos-numeric font-medium text-foreground">
          {durationSec != null ? formatApproxDurationSeconds(durationSec, { style: "long" }) : "—"}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Peg reference</dt>
        <dd className="pharos-numeric font-medium text-foreground">{formatPrice(event.pegReference) ?? "—"}</dd>
      </div>
      {startPrice ? (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Start price</dt>
          <dd className="pharos-numeric font-medium text-foreground">{startPrice}</dd>
        </div>
      ) : null}
      {peakPrice ? (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Peak price</dt>
          <dd className="pharos-numeric font-medium text-foreground">{peakPrice}</dd>
        </div>
      ) : null}
      {recoveryPrice ? (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Recovery price</dt>
          <dd className="pharos-numeric font-medium text-foreground">{recoveryPrice}</dd>
        </div>
      ) : null}
    </dl>
  );
}

export default async function DepegEventPage(
  { params }: { params: Promise<{ event: string }> },
) {
  const { event: slug } = await params;
  const event = eventBySlug.get(slug);
  if (!event) notFound();

  const coin = TRACKED_META_BY_ID.get(event.stablecoinId);
  const curated = findCuratedAnnotation(event);
  const heroTitle = curated?.label ?? buildHeroTitle(event, coin?.name ?? null);
  const heroDescription = buildHeroDescription(event);
  const methodologyVersion = getDepegDewsMethodologyVersionAt(event.startedAt);
  const versionLabel = toMethodologyVersionLabel(methodologyVersion);
  const canonicalUrl = `${SITE_URL}/depeg/${event.slug}/`;

  const authoredEditorial = getDepegEditorial(event.slug);
  const qualifiesForBriefing = qualifiesForEditorialBriefing({
    peakDeviationBps: event.peakDeviationBps,
    startedAt: event.startedAt,
    endedAt: event.endedAt,
    hasCuratedAnnotation: curated != null,
    hasAuthoredEditorial: authoredEditorial != null,
  });
  // Only promote to the authored briefing layout when (a) an editorial entry
  // exists and (b) the event clears the threshold. The qualification gate
  // prevents an accidentally-authored low-severity event from receiving
  // briefing treatment; the entry gate prevents qualifying-but-unauthored
  // events from rendering a half-authored shell.
  const editorial = qualifiesForBriefing ? authoredEditorial : null;
  const incidentNumber = formatIncidentNumber(event.slug);
  const coinDisplayName = coin?.name ?? event.symbol;
  const incidentKicker = incidentNumber
    ? `Incident ${incidentNumber} · ${event.symbol} · ${formatLongDate(event.startedAt)}`
    : null;
  const timelineParagraphs = editorial ? splitDigestParagraphs(editorial.timeline) : [];

  // Find prev/next confirmed events for the same coin (sorted desc by startedAt)
  const sameCoin = DEPEG_EVENT_ENTRIES.filter((e) => e.stablecoinId === event.stablecoinId);
  const sameCoinIdx = sameCoin.findIndex((e) => e.slug === event.slug);
  const newer = sameCoinIdx > 0 ? sameCoin[sameCoinIdx - 1] : null;
  const older = sameCoinIdx >= 0 && sameCoinIdx < sameCoin.length - 1 ? sameCoin[sameCoinIdx + 1] : null;

  const startedIso = new Date(event.startedAt * 1000).toISOString();
  const endedIso = event.endedAt ? new Date(event.endedAt * 1000).toISOString() : null;

  const newsArticleJsonLd = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: heroTitle,
    description: heroDescription,
    datePublished: startedIso,
    dateModified: endedIso ?? startedIso,
    image: [`${SITE_URL}/og-editorial-depeg.png`],
    author: { "@type": "Organization", name: "Pharos", url: SITE_URL },
    publisher: {
      "@type": "Organization",
      name: "Pharos",
      url: SITE_URL,
      logo: `${SITE_URL}/pharos-icon.png`,
    },
    mainEntityOfPage: canonicalUrl,
    identifier: [buildPharosUrnJsonLdIdentifier("depeg-event", event.slug)],
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Depeg Tracker", url: "/depeg/" },
          { name: heroTitle, url: `/depeg/${event.slug}/` },
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: safeJsonLd(newsArticleJsonLd) }}
      />

      <div className="space-y-2">
        <p className="pharos-kicker">
          {editorial && incidentKicker ? incidentKicker : "Depeg event"}
        </p>
        {editorial ? (
          <p
            className={`${digestDisplay.className} text-[clamp(1.15rem,2.1vw,1.5rem)] font-normal leading-snug text-foreground/92 [text-wrap:balance]`}
          >
            {editorial.lede}
          </p>
        ) : null}
        <h1 className="pharos-page-title [text-wrap:balance]">
          {heroTitle}
        </h1>
        <ProvenanceLine event={event} />
      </div>

      {editorial && timelineParagraphs.length > 0 ? (
        <article
          aria-label={`${coinDisplayName} depeg briefing`}
          className="mx-auto max-w-[68ch] space-y-4"
        >
          {timelineParagraphs.map((para, i) => (
            <p
              key={i}
              className="text-[1.05rem] leading-8 text-foreground/92"
              style={EDITORIAL_BODY_STYLE}
            >
              {para}
            </p>
          ))}
          <div className="space-y-2 border-t border-border/40 pt-4">
            <p className="pharos-kicker">What to watch next time</p>
            <p
              className="text-[1.05rem] leading-8 text-foreground/92"
              style={EDITORIAL_BODY_STYLE}
            >
              {editorial.watchpoints}
            </p>
          </div>
        </article>
      ) : null}

      <section className="pharos-card-shell space-y-4 px-5 py-5">
        <p className="pharos-kicker">Event summary</p>
        <RecoveryPanel event={event} />
      </section>

      <RelatedIncidentsRail
        excludeEventId={event.slug}
        pegCurrency={event.pegType}
        riskArchetype={coin ? resolveMechanismArchetype(coin, TRACKED_META_BY_ID) ?? undefined : undefined}
        startedAt={event.startedAt}
      />

      {coin ? (
        <section className="pharos-card-shell space-y-2 px-5 py-5">
          <p className="pharos-kicker">Stablecoin</p>
          <Link
            href={buildStablecoinUrl(coin.id)}
            className="pharos-focus-ring text-frost-blue underline-offset-2 hover:underline"
          >
            {coin.name} ({coin.symbol}) →
          </Link>
          {coin.oneLiner ? (
            <p className="text-sm text-muted-foreground">{coin.oneLiner}</p>
          ) : null}
        </section>
      ) : null}

      {CASE_STUDY_BY_DEPEG_SLUG[event.slug] ? (
        <section className="pharos-card-shell space-y-2 px-5 py-5">
          <p className="pharos-kicker">Deep dive</p>
          <Link
            href={`/learn/case-studies/${CASE_STUDY_BY_DEPEG_SLUG[event.slug].slug}/`}
            className="pharos-focus-ring text-frost-blue underline-offset-2 hover:underline"
          >
            {CASE_STUDY_BY_DEPEG_SLUG[event.slug].title} — full case study →
          </Link>
        </section>
      ) : null}

      {curated?.href ? (
        <section className="pharos-card-shell space-y-2 px-5 py-5">
          <p className="pharos-kicker">Primary source</p>
          <a
            href={curated.href}
            target="_blank"
            rel="noopener noreferrer"
            className="pharos-focus-ring text-frost-blue underline-offset-2 hover:underline"
          >
            {curated.label} ↗
          </a>
        </section>
      ) : null}

      {newer || older ? (
        <nav
          aria-label="Event navigation"
          className="flex items-center justify-between border-t border-border/50 pt-4 text-sm"
        >
          {older ? (
            <Link
              href={`/depeg/${older.slug}/`}
              aria-label={`Older ${older.symbol} depeg: ${formatIsoDate(older.startedAt)}`}
              className="pharos-focus-ring text-muted-foreground transition-colors hover:text-foreground"
            >
              ← {older.symbol} {formatIsoDate(older.startedAt)}
            </Link>
          ) : (
            <span />
          )}
          {newer ? (
            <Link
              href={`/depeg/${newer.slug}/`}
              aria-label={`Newer ${newer.symbol} depeg: ${formatIsoDate(newer.startedAt)}`}
              className="pharos-focus-ring text-muted-foreground transition-colors hover:text-foreground"
            >
              {newer.symbol} {formatIsoDate(newer.startedAt)} →
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Methodology pin:{" "}
        <Link
          href={DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH}
          className="pharos-focus-ring underline-offset-2 hover:underline"
        >
          {versionLabel} changelog
        </Link>
      </p>
    </div>
  );
}
