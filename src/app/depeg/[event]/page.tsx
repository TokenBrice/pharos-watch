import { hasUnverifiedDepegPeak } from "@/lib/depeg-event-config";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { JsonLdScript } from "@/components/json-ld-script";
import { PreferredSourcePrompt } from "@/components/preferred-source-prompt";
import { RelatedIncidentsRail } from "@/components/related-incidents-rail";
import { buildPageMetadata, getPageSocialPreview } from "@/lib/page-metadata";
import { buildArticleJsonLd, safeJsonLd } from "@/lib/json-ld";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";
import { buildStablecoinUrl } from "@shared/lib/urls";
import { DEPEG_AUDIT_DISPUTED_BADGE, resolveMechanismArchetype } from "@shared/lib/classification";
import { isDisputedAuditVerdict } from "@shared/lib/depeg-audit";
import { formatApproxDurationSeconds } from "@shared/lib/relative-time";
import { formatDeviationBps, formatIsoTimestamp } from "@shared/lib/format";
import { getPegTaxonomyByType } from "@shared/lib/peg-taxonomy";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DEPEG_DEWS_METHODOLOGY_CHANGELOG_PATH } from "@shared/lib/methodology-versions/constants";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
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
  NOINDEX_DEPEG_EVENT_SLUGS,
  type DepegEventEntry,
} from "@/lib/depeg-event-page-data";
import {
  buildDepegEventDescription,
  buildDepegEventSynopsis,
  buildDepegEventMetaTitle, buildDepegEventTitle,
  depegDirectionLabel,
  formatEventNavigationLabel,
  formatEventPrice,
  formatEventTimestamp,
  formatEventUtcTime,
  getDepegEventClosurePresentation,
  getDepegEventOnset,
  hasUnverifiedAnalyticRecovery,
} from "@/lib/depeg-event-display";
import { getDepegEditorial } from "./editorials";
import { DepegEventNowStrip } from "./now-strip";
import { CASE_STUDY_BY_DEPEG_SLUG } from "@/lib/case-studies";
import {
  formatDepegCloseReason,
  formatDepegConfirmationSources,
  formatDepegPendingReason,
} from "@/components/depeg/depeg-provenance-badges";

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
  const title = buildDepegEventMetaTitle(event, isCollision);
  const description = buildDepegEventDescription(event, isCollision, coin?.name ?? null);
  return buildPageMetadata({
    title,
    description,
    canonical: `/depeg/${event.slug}/`,
    ...(hasUnverifiedDepegPeak(event) ? { socialPreview: { ...getPageSocialPreview("/depeg/"), title, description } } : {}),
    robots: NOINDEX_DEPEG_EVENT_SLUGS.has(event.slug) ? { index: false, follow: true } : undefined,
  });
}

const PROVENANCE_BADGE_CLASS = "inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-3xs font-medium leading-none";

function ProvenanceLine({ event }: { event: DepegEventEntry }) {
  const methodologyVersion = getMethodologyVersionAt("depeg-dews", event.startedAt);
  const versionLabel = toMethodologyVersionLabel(methodologyVersion);
  const provenance = event.provenance ?? null;
  const disputed = isDisputedAuditVerdict(provenance?.auditVerdict);
  const parts: string[] = [`Detected under ${versionLabel}`];
  if (provenance?.confidenceTier) parts.push(`${provenance.confidenceTier} confidence`);
  if (provenance?.auditVerdict && !disputed) parts.push(`audit: ${provenance.auditVerdict}`);
  if (event.confirmationSources) parts.push(`confirmed via ${formatDepegConfirmationSources(event.confirmationSources)}`);
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
      {disputed ? (
        <span className={`${PROVENANCE_BADGE_CLASS} ${DEPEG_AUDIT_DISPUTED_BADGE.className}`}>
          {DEPEG_AUDIT_DISPUTED_BADGE.label}
        </span>
      ) : null}
      <span>{parts.join(" · ")}</span>
    </p>
  );
}

/**
 * Compact visual price-path stepper (Start → Peak → Recovery/Outcome) rendered
 * at the top of the Event summary card. Preserves non-recovery closure labels
 * and unverified peaks without inventing absent prices.
 */
function PricePathBar({ event }: { event: DepegEventEntry }) {
  const startLabel = event.onsetQuoteFromLaterFragment ? "Later quote" : "Start";
  const startPrice = formatEventPrice(event.startPrice, event, "start");
  const peakPrice = formatEventPrice(event.peakPrice, event, "peak");
  const { closure, label: closureLabel, isRecovery } = getDepegEventClosurePresentation(event);
  const recoveryPrice = isRecovery ? formatEventPrice(event.recoveryPrice, event, "recovery") : null;
  const peakUnverified = hasUnverifiedDepegPeak(event);
  const peakDeltaText = peakUnverified
    ? "Peak unverified"
    : `${event.direction === "below" ? "↓" : "↑"} ${formatDeviationBps(event.peakDeviationBps)}`;
  const endLabel = isRecovery ? "Recovery" : closure === "open" ? "Status" : "Outcome";
  const endValue = isRecovery
    ? (recoveryPrice ?? "Recovered")
    : closure === "open"
      ? "Ongoing"
      : closureLabel;

  const peakDotClass = event.direction === "below" ? "bg-state-danger-solid" : "bg-state-warn-solid";
  const peakValueClass = event.direction === "below" ? "text-state-danger" : "text-state-warn";
  const endDotClass = isRecovery
    ? "bg-state-positive-solid"
    : closure === "open"
      ? "bg-state-danger-solid"
      : "bg-muted-foreground";
  const endTrackClass = isRecovery
    ? "border-t border-state-positive-solid/45"
    : "border-t border-dashed border-border";

  return (
    <div
      role="group"
      aria-label="Event price path from start to peak to resolution"
      data-testid="depeg-price-path-bar"
      className="rounded-lg border border-border/60 bg-muted/25 px-3.5 py-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center sm:gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground" aria-hidden="true" />
            <span className="pharos-label">{startLabel}</span>
          </div>
          <p className="pharos-numeric mt-1 text-sm font-semibold text-foreground">
            {startPrice ?? "—"}
          </p>
        </div>

        <div className="hidden w-10 items-center sm:flex" aria-hidden="true">
          <span className="w-full border-t border-border" />
          <span className="ml-0.5 text-2xs text-muted-foreground">→</span>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${peakDotClass}`} aria-hidden="true" />
            <span className="pharos-label">Peak</span>
          </div>
          <p className={`pharos-numeric mt-1 text-sm font-semibold ${peakValueClass}`}>
            {peakPrice ?? peakDeltaText}
          </p>
          {peakPrice ? (
            <p className="pharos-meta pharos-numeric">{peakDeltaText}</p>
          ) : null}
        </div>

        <div className="hidden w-10 items-center sm:flex" aria-hidden="true">
          <span className={`w-full ${endTrackClass}`} />
          <span className="ml-0.5 text-2xs text-muted-foreground">→</span>
        </div>

        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`h-2 w-2 shrink-0 rounded-full ${endDotClass}`} aria-hidden="true" />
            <span className="pharos-label">{endLabel}</span>
          </div>
          <p className="pharos-numeric mt-1 text-sm font-semibold text-foreground">
            {endValue}
          </p>
        </div>
      </div>
    </div>
  );
}

function RecoveryPanel({ event, includeTime }: { event: DepegEventEntry; includeTime: boolean }) {
  const { firstAdmissible, qualified } = getDepegEventOnset(event);
  const showAdmissibleObservation = qualified || firstAdmissible != null;
  const startPrice = formatEventPrice(event.startPrice, event, "start");
  const referenceTiming = event.onsetQuoteFromLaterFragment ? "Later" : "Opening";
  const peakPrice = formatEventPrice(event.peakPrice, event, "peak");
  const { closure, label: closureLabel, isRecovery, end } = getDepegEventClosurePresentation(event);
  const recoveryPrice = isRecovery
    ? formatEventPrice(event.recoveryPrice, event, "recovery")
    : null;
  const affectedSec = event.admittedCoverage?.reduce((seconds, interval) => seconds + interval.toSec - interval.fromSec, 0);
  const showRecordedDuration = qualified || affectedSec !== undefined || (!isRecovery && event.analyticRecoveryAt === null);
  const durationEnd = showRecordedDuration ? event.endedAt : end;
  const durationSec = durationEnd != null ? durationEnd - event.startedAt : null;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-3">
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Direction</dt>
        <dd className="font-medium text-foreground">{depegDirectionLabel(event.direction, event.peakBasis)}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Peak deviation</dt>
        <dd className="pharos-numeric font-medium text-foreground">{formatDeviationBps(event.peakDeviationBps)}{event.peakBasis ? " from peer median · Lower confidence" : ""}{hasUnverifiedDepegPeak(event) ? " · Peak unverified" : ""}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{showAdmissibleObservation ? "Recorded detector start" : "Started"}</dt>
        <dd className="pharos-numeric font-medium text-foreground">
          {formatEventTimestamp(event.startedAt, includeTime || showAdmissibleObservation)}
        </dd>
      </div>
      {showAdmissibleObservation && (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">First admissible observation</dt>
          <dd className="pharos-numeric font-medium text-foreground">
            {firstAdmissible == null ? "Not documented" : formatEventTimestamp(firstAdmissible, true)}
          </dd>
        </div>
      )}
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{isRecovery ? "Recovered" : closure === "open" ? "Ended" : hasUnverifiedAnalyticRecovery(event) ? "Recorded detector close" : "Tracking closed"}</dt>
        <dd className="pharos-numeric font-medium text-foreground">
          {end != null ? formatEventTimestamp(end, includeTime) : "Ongoing"}
        </dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">Outcome</dt>
        <dd className="font-medium text-foreground">{closureLabel}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{showRecordedDuration ? "Recorded duration" : "Duration"}</dt>
        <dd className="pharos-numeric font-medium text-foreground">
          {durationSec != null ? formatApproxDurationSeconds(durationSec, { style: "long" }) : "—"}
        </dd>
      </div>
      {affectedSec !== undefined && (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Admitted affected time</dt>
          <dd className="pharos-numeric font-medium text-foreground">{formatApproxDurationSeconds(affectedSec, { style: "long" })}</dd>
        </div>
      )}
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">{referenceTiming} {event.onsetBasis ? "peer median" : "peg reference"}</dt>
        <dd className="pharos-numeric font-medium text-foreground">
          {formatEventPrice(event.pegReference, event, "reference") ?? "—"}
        </dd>
      </div>
      {startPrice ? (
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{event.onsetQuoteFromLaterFragment ? "Later price" : "Start price"}</dt>
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
  const startPrice = formatEventPrice(event.startPrice, event, "start");
  const pegReference = formatEventPrice(event.pegReference, event, "reference");
  const sourceLabel = event.source === "live" ? "live monitoring" : "a historical backfill";
  const referenceLabel = event.onsetBasis ? "peer median (lower confidence)" : "peg reference";
  const priceLead = event.onsetQuoteFromLaterFragment ? "A later observation shows a price of" : "The checked-in price path starts at";
  const pricePath = startPrice && pegReference
    ? `${priceLead} ${startPrice} against a recorded ${referenceLabel} of ${pegReference}.`
    : startPrice
      ? `${priceLead} ${startPrice}.`
      : pegReference
        ? `${event.onsetQuoteFromLaterFragment ? "A later observation uses" : "The checked-in record uses"} a ${referenceLabel} of ${pegReference}.`
        : "The checked-in record preserves the measured direction and peak deviation.";
  const confirmation = event.confirmationSources
    ? ` Confirmation evidence is recorded as “${formatDepegConfirmationSources(event.confirmationSources)}”.`
    : "";
  const confidenceFlag = event.pendingReason
    ? ` The source row also retains the quality flag “${formatDepegPendingReason(event.pendingReason)}”.`
    : "";
  const closeReason = event.closeReason
    ? ` Its recorded close reason is “${formatDepegCloseReason(event.closeReason)}”.`
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
  const { qualified } = getDepegEventOnset(event);
  const baseHeroTitle = buildDepegEventTitle(event, isCollision);
  const heroTitle = curated?.label
    ? `${curated.label}${isCollision ? ` · ${formatEventUtcTime(event.startedAt)}` : ""}`
    : baseHeroTitle;
  const heroDescription = buildDepegEventDescription(event, isCollision, coin?.name ?? null);
  const eventSynopsis = buildDepegEventSynopsis(event);
  const methodologyVersion = getMethodologyVersionAt("depeg-dews", event.startedAt);
  const versionLabel = toMethodologyVersionLabel(methodologyVersion);
  const eventRecordContext = buildDepegRecordContext({ event, versionLabel });
  const canonicalUrl = `${SITE_URL}/depeg/${event.slug}/`;

  const editorial = getDepegEditorial(event.slug);
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

  const modifiedAtSeconds = isCollision
    ? Math.max(event.endedAt ?? event.startedAt, DEPEG_COLLISION_CONTENT_REVISED_AT_SECONDS)
    : (event.endedAt ?? event.startedAt);

  const newsArticleJsonLd = buildArticleJsonLd({
    type: "NewsArticle",
    id: canonicalUrl,
    headline: heroTitle,
    description: heroDescription,
    // The record's publication date is its detector start, whether or not the onset is qualified.
    datePublished: formatIsoTimestamp(event.startedAt),
    ...(event.endedAt != null || !qualified ? { dateModified: formatIsoTimestamp(modifiedAtSeconds) } : {}),
    image: [`${SITE_URL}${getPageSocialPreview(hasUnverifiedDepegPeak(event) ? "/depeg/" : canonicalUrl).url}`],
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
      <JsonLdScript json={safeJsonLd(newsArticleJsonLd)} />

      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Link
          href="/depeg/"
          className="pharos-focus-ring inline-flex min-h-11 items-center gap-1 rounded-sm font-medium text-foreground underline-offset-4 hover:underline sm:min-h-0"
        >
          ← Depeg Tracker
        </Link>
        <span aria-hidden="true">/</span>
        <Link
          href="/depeg/archive/"
          className="pharos-focus-ring inline-flex min-h-11 items-center rounded-sm hover:text-foreground hover:underline sm:min-h-0"
        >
          Event Archive
        </Link>
      </nav>

      {/* The record below is the build snapshot; a still-open event leads with its live state. */}
      {event.endedAt == null ? (
        <DepegEventNowStrip
          stablecoinId={event.stablecoinId}
          eventId={event.id}
          symbol={event.symbol}
          startedAt={event.startedAt}
        />
      ) : null}

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
        <PricePathBar event={event} />
        <RecoveryPanel event={event} includeTime={isCollision} />
      </section>

      <RelatedIncidentsRail
        excludeEventId={event.slug}
        pegCurrency={getPegTaxonomyByType(event.pegType)?.currency}
        riskArchetype={coin ? resolveMechanismArchetype(coin, TRACKED_META_BY_ID) ?? undefined : undefined}
        startedAt={event.startedAt}
      />

      {coin ? (
        <section className="pharos-card-shell space-y-2 px-5 py-5">
          <p className="pharos-kicker">Stablecoin</p>
          <Link
            href={buildStablecoinUrl(coin.id)}
            className="pharos-focus-ring text-brand-accent-text underline-offset-2 hover:underline"
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
            className="pharos-focus-ring text-brand-accent-text underline-offset-2 hover:underline"
          >
            {CASE_STUDY_BY_DEPEG_SLUG[event.slug].title}: full case study →
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
            className="pharos-focus-ring text-brand-accent-text underline-offset-2 hover:underline"
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
