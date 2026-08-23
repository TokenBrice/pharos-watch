import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { PreferredSourcePrompt } from "@/components/preferred-source-prompt";
import { RelatedIncidentsRail } from "@/components/related-incidents-rail";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { resolveMechanismArchetype } from "@shared/lib/classification";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";
import { formatDeviationBps } from "@shared/lib/format";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH,
  getDepegDewsMethodologyVersionAt,
} from "@shared/lib/methodology-versions/depeg-dews";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import { getCuratedAnnotations } from "@shared/data/annotations/curated-annotations";
import type { ChartAnnotation } from "@shared/types/chart-annotation";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { EDITORIAL_BODY_STYLE, splitDigestParagraphs } from "@/lib/digest";
import { digestDisplay } from "@/lib/fonts/digest";
import {
  COLLIDING_DEPEG_EVENT_SLUGS,
  DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS,
  DEPEG_EVENT_ENTRIES,
  eventBySlug,
  formatIncidentNumber,
  type DepegEventEntry,
} from "@/lib/depeg-event-page-data";
import {
  buildDepegEventDescription,
  buildDepegEventSynopsis,
  buildDepegEventTitle,
  depegDirectionLabel,
  formatEventNavigationLabel,
  formatEventPrice,
  formatEventTimestamp,
  formatEventUtcTime,
} from "@/lib/depeg-event-display";
import { getDepegEditorial, qualifiesForEditorialBriefing } from "./editorials";
import { CASE_STUDY_BY_DEPEG_SLUG } from "@/lib/case-studies";

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

export async function generateMetadata(
  { params }: { params: Promise<{ event: string }> },
): Promise<Metadata> {
  const { event: slug } = await params;
  const event = eventBySlug.get(slug);
  if (!event) {
    return { title: "Depeg Event Not Found", robots: { index: false } };
  }
  const coin = TRACKED_META_BY_ID.get(event.stablecoinId);
  const isCollision = COLLIDING_DEPEG_EVENT_SLUGS.has(event.slug);
  const title = buildDepegEventTitle(event, coin?.name ?? null, isCollision);
  const description = buildDepegEventDescription(event, isCollision);
  return buildPageMetadata({
    title,
    description,
    canonical: `/depeg/${event.slug}/`,
    ogImage: `${SITE_URL}/og-editorial-depeg.png`,
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

function RecoveryPanel({ event, includeTime }: { event: DepegEventEntry; includeTime: boolean }) {
  const startPrice = formatEventPrice(event.startPrice);
  const peakPrice = formatEventPrice(event.peakPrice);
  const recoveryPrice = formatEventPrice(event.recoveryPrice);
  const durationSec = event.endedAt ? event.endedAt - event.startedAt : null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Direction</dt>
        <dd className="font-medium text-foreground">{depegDirectionLabel(event.direction)}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Peak deviation</dt>
        <dd className="pharos-numeric font-medium text-foreground">{formatDeviationBps(event.peakDeviationBps)}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Started</dt>
        <dd className="pharos-numeric font-medium text-foreground">
          {formatEventTimestamp(event.startedAt, includeTime)}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Ended</dt>
        <dd className="pharos-numeric font-medium text-foreground">
          {event.endedAt ? formatEventTimestamp(event.endedAt, includeTime) : "Ongoing"}
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
        <dd className="pharos-numeric font-medium text-foreground">
          {formatEventPrice(event.pegReference) ?? "—"}
        </dd>
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

function buildDepegRecordContext({
  event,
  versionLabel,
}: {
  event: DepegEventEntry;
  versionLabel: string;
}): string {
  const startPrice = formatEventPrice(event.startPrice);
  const pegReference = formatEventPrice(event.pegReference);
  const sourceLabel = event.source === "live" ? "live monitoring" : "a historical backfill";
  const pricePath = startPrice && pegReference
    ? `The checked-in price path starts at ${startPrice} against a recorded peg reference of ${pegReference}.`
    : startPrice
      ? `The checked-in price path starts at ${startPrice}.`
      : pegReference
        ? `The checked-in record uses a peg reference of ${pegReference}.`
        : "The checked-in record preserves the measured direction and peak deviation.";
  const confirmation = event.confirmationSources
    ? ` Confirmation evidence is recorded as “${event.confirmationSources}”.`
    : "";
  const confidenceFlag = event.pendingReason
    ? ` The source row also retains the quality flag “${event.pendingReason}”.`
    : "";
  const closeReason = event.closeReason
    ? ` Its recorded close reason is “${event.closeReason}”.`
    : "";

  return `${pricePath} Pharos captured the incident through ${sourceLabel} and evaluates it under ${versionLabel}.${confirmation}${confidenceFlag}${closeReason} The record reports the observed price path and resolution state without inferring a cause from those measurements.`;
}

export default async function DepegEventPage(
  { params }: { params: Promise<{ event: string }> },
) {
  const { event: slug } = await params;
  const event = eventBySlug.get(slug);
  if (!event) notFound();

  const coin = TRACKED_META_BY_ID.get(event.stablecoinId);
  const curated = findCuratedAnnotation(event);
  const isCollision = COLLIDING_DEPEG_EVENT_SLUGS.has(event.slug);
  const baseHeroTitle = buildDepegEventTitle(event, coin?.name ?? null, isCollision);
  const heroTitle = curated?.label
    ? `${curated.label}${isCollision ? ` — ${formatEventUtcTime(event.startedAt)}` : ""}`
    : baseHeroTitle;
  const heroDescription = buildDepegEventDescription(event, isCollision);
  const eventSynopsis = buildDepegEventSynopsis(event);
  const methodologyVersion = getDepegDewsMethodologyVersionAt(event.startedAt);
  const versionLabel = toMethodologyVersionLabel(methodologyVersion);
  const eventRecordContext = buildDepegRecordContext({ event, versionLabel });
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
    ? `Incident ${incidentNumber} · ${event.symbol} · ${formatEventTimestamp(event.startedAt, isCollision)}`
    : null;
  const timelineParagraphs = editorial ? splitDigestParagraphs(editorial.timeline) : [];

  // Find prev/next confirmed events for the same coin (sorted desc by startedAt)
  const sameCoin = DEPEG_EVENT_ENTRIES.filter((e) => e.stablecoinId === event.stablecoinId);
  const sameCoinIdx = sameCoin.findIndex((e) => e.slug === event.slug);
  const newer = sameCoinIdx > 0 ? sameCoin[sameCoinIdx - 1] : null;
  const older = sameCoinIdx >= 0 && sameCoinIdx < sameCoin.length - 1 ? sameCoin[sameCoinIdx + 1] : null;

  const startedIso = new Date(event.startedAt * 1000).toISOString();
  const modifiedAtSeconds = isCollision
    ? Math.max(event.endedAt ?? event.startedAt, DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS)
    : (event.endedAt ?? event.startedAt);
  const modifiedIso = new Date(modifiedAtSeconds * 1000).toISOString();

  const newsArticleJsonLd = buildArticleJsonLd({
    type: "NewsArticle",
    id: canonicalUrl,
    headline: heroTitle,
    description: heroDescription,
    datePublished: startedIso,
    dateModified: modifiedIso,
    image: [`${SITE_URL}/og-editorial-depeg.png`],
    mainEntityOfPage: canonicalUrl,
    identifier: [buildPharosUrnJsonLdIdentifier("depeg-event", event.slug)],
  });

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
        <div className="max-w-[72ch] space-y-3 text-sm leading-6 text-muted-foreground">
          <p>{eventSynopsis}</p>
          <p>{eventRecordContext}</p>
        </div>
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
        <RecoveryPanel event={event} includeTime={isCollision} />
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

      <PreferredSourcePrompt />

      {newer || older ? (
        <nav
          aria-label="Event navigation"
          className="flex items-center justify-between border-t border-border/50 pt-4 text-sm"
        >
          {older ? (
            <Link
              href={`/depeg/${older.slug}/`}
              aria-label={`Older ${formatEventNavigationLabel(older, COLLIDING_DEPEG_EVENT_SLUGS.has(older.slug))} depeg`}
              className="pharos-focus-ring text-muted-foreground transition-colors hover:text-foreground"
            >
              ← {formatEventNavigationLabel(older, COLLIDING_DEPEG_EVENT_SLUGS.has(older.slug))}
            </Link>
          ) : (
            <span />
          )}
          {newer ? (
            <Link
              href={`/depeg/${newer.slug}/`}
              aria-label={`Newer ${formatEventNavigationLabel(newer, COLLIDING_DEPEG_EVENT_SLUGS.has(newer.slug))} depeg`}
              className="pharos-focus-ring text-muted-foreground transition-colors hover:text-foreground"
            >
              {formatEventNavigationLabel(newer, COLLIDING_DEPEG_EVENT_SLUGS.has(newer.slug))} →
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
