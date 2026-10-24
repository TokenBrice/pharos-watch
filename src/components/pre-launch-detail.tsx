import Link from "next/link";
import Image from "next/image";
import { Suspense } from "react";
import { ExternalLink, BookOpen, Play } from "lucide-react";
import { CLIENT_TRACKED_META_BY_ID, CLIENT_TRACKED_STABLECOINS } from "@shared/lib/stablecoins/client-registry";
import { isActiveStablecoinMeta, isPreLaunchStablecoinMeta } from "@shared/lib/stablecoins/status";
import {
  BACKING_LABELS,
  GOVERNANCE_LABELS,
  HERO_CHIP_BACKING_LABELS,
  HERO_CHIP_GOVERNANCE_LABELS,
  HERO_CHIP_PEG_LABELS,
  PEG_LABELS_SHORT,
  PRE_LAUNCH_ACCENT_CLASSES,
  getHeroPegLabel,
} from "@shared/lib/classification";
import { CHAIN_META } from "@shared/types/chain-identity";
import { cn } from "@/lib/utils";
import { AiSummary } from "@/components/ai-summary";
import { IntentLink } from "@/components/intent-link";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { PreLaunchTweetEmbed } from "@/components/pre-launch-tweet-embed";
import { LaunchMilestoneBadge } from "@/components/pre-launch-badge";
import { PreLaunchAlertAction } from "@/components/pre-launch-alert-action";
import { PreLaunchLaunchPath } from "@/components/pre-launch-launch-path";
import { PreLaunchReadiness } from "@/components/pre-launch-readiness";
import { EvidenceFooter } from "@/components/stablecoin-detail/evidence-footer";
import { EvidenceModule, EvidenceStateStrip } from "@/components/stablecoin-detail/evidence-module";
import { FactGrid, type FactGridItem } from "@/components/stablecoin-detail/fact-grid";
import { InfrastructureBadge } from "@/components/stablecoin-detail/hero-card-identity";
import { KeyLinksCard } from "@/components/stablecoin-detail/key-links-card";
import { linkIconFor } from "@/components/stablecoin-detail/link-icon";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { StablecoinDetailIdentityProvider } from "@/components/stablecoin-detail/module-title";
import { RailCard } from "@/components/stablecoin-detail/rail-card";
import { DetailSectionTitle } from "@/components/stablecoin-detail/section-title";
import { JsonLdScript } from "@/components/json-ld-script";
import { STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE } from "@/components/stablecoin-detail/constants";
import { getRelatedStablecoins } from "@/lib/related-stablecoins";
import { getLogoSrc, logosById } from "@/lib/logos";
import { buildPegLandingUrl } from "@/lib/peg-landing";
import { buildBackingTaxonomyUrl, buildGovernanceTaxonomyUrl } from "@/lib/stablecoin-taxonomy-urls";
import { formatFuzzyDate } from "@/lib/pre-launch";
import { buildLaunchVerdict, describeTargetHistory, sortMilestonesNewestFirst } from "@/lib/pre-launch-dossier";
import { buildPreLaunchQuickAnswers } from "@/lib/pre-launch-quick-answers";
import { buildFaqJsonLd } from "@/lib/faq";
import { safeJsonLd } from "@/lib/json-ld";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { FeaturedContent, LaunchMilestone, StablecoinAiSummary, StablecoinMeta } from "@shared/types";

/** Live surfaces a pre-launch dossier gains at its first post-launch data sync. */
const LIVE_SURFACES = "Price & peg · Supply & flows · Liquidity · Safety Score · DEWS";

/** Newest milestones shown before the "Earlier activity" fold. */
const VISIBLE_MILESTONES = 5;

const HEADER_ACTION_CLASS =
  "pharos-focus-ring hidden size-11 items-center justify-center rounded-md border border-border/60 bg-card text-muted-foreground transition-colors hover:border-border hover:bg-muted/60 hover:text-foreground sm:inline-flex lg:size-8";

const HERO_CHIP_CLASS =
  "pharos-focus-ring inline-flex h-5 items-center rounded-full bg-muted/70 px-2.5 text-xs font-medium leading-none text-foreground/80 transition-colors hover:bg-muted";

function ContentTypeIcon({ type }: { type: FeaturedContent["type"] }) {
  const cls = "h-3.5 w-3.5";
  switch (type) {
    case "blog":
    case "article":
      return <BookOpen className={cls} aria-hidden="true" />;
    case "video":
      return <Play className={cls} aria-hidden="true" />;
    default:
      return <ExternalLink className={cls} aria-hidden="true" />;
  }
}

/** Extract tweet ID from an x.com or twitter.com URL. */
function extractTweetId(url: string): string | null {
  const match = url.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function chainName(chain: string): string {
  return CHAIN_META[chain]?.name ?? chain;
}

// ---------------------------------------------------------------------------
// Identity header and hero
// ---------------------------------------------------------------------------

/** The dossier identity header (`HeroIdentityHeader` grammar); the visible `h1` lives here. */
function PreLaunchIdentityHeader({ coin, logoSrc }: { coin: StablecoinMeta; logoSrc: string | undefined }) {
  const links = (coin.links ?? []).slice(0, 3);
  return (
    <header className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-3">
          <StablecoinLogo src={logoSrc} name={coin.name} size={STABLECOIN_DETAIL_IDENTITY_LOGO_SIZE} />
          <div className="flex min-w-0 flex-col gap-1 lg:flex-row lg:items-center lg:gap-3">
            <span className="pharos-label shrink-0">{coin.symbol}</span>
            <h1 className="pharos-page-title min-w-0 break-words text-xl leading-tight tracking-normal sm:text-2xl lg:leading-none">
              {coin.name}
              <span className="sr-only"> ({coin.symbol}) pre-launch stablecoin tracker</span>
            </h1>
          </div>
        </div>
        {coin.oneLiner ? (
          <p className="mt-2 max-w-none text-pretty text-sm leading-relaxed text-muted-foreground">{coin.oneLiner}</p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 lg:shrink-0 lg:flex-nowrap lg:pt-1">
        {links.map((link) => {
          const Icon = linkIconFor(link.label);
          return (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              // Below sm the in-flow Key Links card carries these.
              className={HEADER_ACTION_CLASS}
              aria-label={`${link.label} (opens in new tab)`}
              title={link.label}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          );
        })}
        {links.length > 0 ? <span aria-hidden="true" className="mx-1 hidden h-4 w-px bg-border/60 sm:block" /> : null}
        <PreLaunchAlertAction description={`Pharos's Telegram channel digest lists ${coin.symbol} once Pharos starts tracking it live`} />
      </div>
    </header>
  );
}

function PreLaunchChipRail({ coin }: { coin: StablecoinMeta }) {
  const pegLabel =
    (coin.flags.navToken
      ? getHeroPegLabel(
          coin.flags,
          coin.pegReferenceId ? CLIENT_TRACKED_META_BY_ID.get(coin.pegReferenceId)?.symbol : undefined,
        )
      : null) ?? HERO_CHIP_PEG_LABELS[coin.flags.pegCurrency];
  const pegLandingUrl = buildPegLandingUrl(coin.flags.pegCurrency);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border/40 px-4 py-2.5 sm:px-5">
      <span
        className={cn(
          "inline-flex h-5 items-center rounded-full border px-2.5 text-xs font-medium leading-none",
          PRE_LAUNCH_ACCENT_CLASSES.preLaunchCard.border,
          PRE_LAUNCH_ACCENT_CLASSES.preLaunchCard.bg,
          PRE_LAUNCH_ACCENT_CLASSES.preLaunchCard.text,
        )}
      >
        Pre-launch · no market data yet
      </span>
      {pegLandingUrl ? (
        <IntentLink href={pegLandingUrl} className={HERO_CHIP_CLASS}>
          {pegLabel}
        </IntentLink>
      ) : (
        <span className={HERO_CHIP_CLASS}>{pegLabel}</span>
      )}
      <IntentLink href={buildBackingTaxonomyUrl(coin.flags.backing)} className={HERO_CHIP_CLASS}>
        {HERO_CHIP_BACKING_LABELS[coin.flags.backing]}
      </IntentLink>
      <IntentLink href={buildGovernanceTaxonomyUrl(coin.flags.governance)} className={HERO_CHIP_CLASS}>
        {HERO_CHIP_GOVERNANCE_LABELS[coin.flags.governance]}
      </IntentLink>
      {(coin.infrastructures ?? []).map((value) => (
        <InfrastructureBadge key={value} value={value} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Launch path and activity
// ---------------------------------------------------------------------------

function LaunchPathModule({ coin }: { coin: StablecoinMeta }) {
  const history = describeTargetHistory(coin.dateHistory);

  return (
    <EvidenceModule
      id="launch-path"
      title="Launch path"
      variant="module"
      headingLevel="h2"
      visual={<PreLaunchLaunchPath coin={coin} />}
      verdict={buildLaunchVerdict(coin)}
      folds={
        <>
          {history.length > 0 ? (
            <ModuleDisclosure id="target-history" label="Target history" count={history.length}>
              <ol className="mt-1 space-y-1.5 pb-1 text-xs text-muted-foreground">
                {history.map((entry) => (
                  <li key={entry.key} className="flex flex-wrap items-baseline gap-x-2">
                    <span className="pharos-numeric text-foreground line-through decoration-muted-foreground/60">{entry.target}</span>
                    <span>retired {entry.retiredOn}</span>
                  </li>
                ))}
                {coin.expectedLaunchDate ? (
                  <li className="flex flex-wrap items-baseline gap-x-2">
                    <span className="pharos-numeric font-semibold text-foreground">{formatFuzzyDate(coin.expectedLaunchDate)}</span>
                    <span>current target</span>
                  </li>
                ) : null}
              </ol>
            </ModuleDisclosure>
          ) : null}
          {coin.launchPhaseDetail ? (
            <ModuleDisclosure id="launch-status" label="Launch status narrative">
              <p className="mt-1 break-words pb-1 text-sm leading-relaxed text-muted-foreground">{coin.launchPhaseDetail}</p>
            </ModuleDisclosure>
          ) : null}
        </>
      }
      // Keyed: React's dev key check flags this server-built footer inside the
      // client module's fold run.
      footer={
        <EvidenceFooter key="footer">
          <span>Registry dates (UTC); a quarter, half or year target draws as its whole window.</span>
        </EvidenceFooter>
      }
    />
  );
}

/** Launch-intent answers from registry fields only; the FAQPage JSON-LD mirrors the visible text. */
function LaunchQuickAnswers({ coin }: { coin: StablecoinMeta }) {
  const items = buildPreLaunchQuickAnswers(coin);
  return (
    <section id="launch-quick-answers" aria-labelledby="launch-quick-answers-title" className="space-y-3">
      <DetailSectionTitle id="launch-quick-answers-title">Launch status: quick answers</DetailSectionTitle>
      <dl className="pharos-card-shell gap-0 divide-y divide-border/50 py-0">
        {items.map((item) => (
          <div key={item.question} className="px-4 py-3 sm:px-5">
            <dt className="text-sm font-medium text-foreground">{item.question}</dt>
            <dd className="mt-1 break-words text-sm leading-relaxed text-muted-foreground">{item.answer}</dd>
          </div>
        ))}
      </dl>
      <JsonLdScript json={safeJsonLd(buildFaqJsonLd(items))} />
    </section>
  );
}

function MilestoneList({ milestones }: { milestones: LaunchMilestone[] }) {
  return (
    <ol className="space-y-0">
      {milestones.map((m, i) => (
        <li key={`${m.date}-${m.title}`} className="relative flex gap-3 pb-4 last:pb-0">
          {i < milestones.length - 1 ? (
            <span aria-hidden="true" className="absolute bottom-0 left-[4.5px] top-4 w-px bg-border/60" />
          ) : null}
          {/* The same glyphs as the Launch path plot: dot, or diamond for a delay. */}
          <span aria-hidden="true" className="mt-1.5 flex h-2.5 w-2.5 shrink-0 items-center justify-center">
            <span className={m.type === "delay" ? "h-2 w-2 rotate-45 bg-state-warn-solid" : "h-2.5 w-2.5 rounded-full bg-foreground/75"} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <time dateTime={m.date} className="pharos-numeric text-xs text-muted-foreground">
                {formatFuzzyDate(m.date)}
              </time>
              <LaunchMilestoneBadge type={m.type} />
            </div>
            <p className="mt-1 text-sm font-medium text-foreground">{m.title}</p>
            {m.description ? (
              <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">{m.description}</p>
            ) : null}
            {m.sourceUrl ? (
              <a
                href={m.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="pharos-focus-ring mt-1 inline-flex min-h-6 items-center gap-1 rounded-sm text-2xs text-muted-foreground hover:text-foreground hover:underline"
              >
                Source
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ActivityModule({ coin }: { coin: StablecoinMeta }) {
  const milestones = sortMilestonesNewestFirst(coin.milestones);
  if (milestones.length === 0) {
    return <EvidenceStateStrip id="activity" title="Activity" state="not-reviewed" reason="no milestones logged yet" density="main" headingLevel="h2" />;
  }
  const visible = milestones.slice(0, VISIBLE_MILESTONES);
  const earlier = milestones.slice(VISIBLE_MILESTONES);
  const sourced = milestones.filter((m) => m.sourceUrl).length;

  return (
    <EvidenceModule
      id="activity"
      title="Activity"
      variant="module"
      headingLevel="h2"
      folds={
        earlier.length > 0 ? (
          <ModuleDisclosure id="earlier-activity" label="Earlier activity" count={earlier.length}>
            <div className="mt-2 pb-1">
              <MilestoneList milestones={earlier} />
            </div>
          </ModuleDisclosure>
        ) : null
      }
      footer={
        <EvidenceFooter key="footer">
          <span className="pharos-numeric">
            {milestones.length} {milestones.length === 1 ? "entry" : "entries"} · {sourced} sourced
          </span>
        </EvidenceFooter>
      }
    >
      <MilestoneList milestones={visible} />
    </EvidenceModule>
  );
}

// ---------------------------------------------------------------------------
// Featured coverage
// ---------------------------------------------------------------------------

function FeaturedCoverage({ items }: { items: FeaturedContent[] }) {
  return (
    <section aria-labelledby="featured-coverage-title" className="space-y-3">
      <DetailSectionTitle id="featured-coverage-title">Featured coverage</DetailSectionTitle>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {items.map((item) => {
          const tweetId = item.type === "tweet" ? extractTweetId(item.url) : null;

          /* ── Tweet embed ─────────────────────────────────── */
          if (tweetId) {
            return (
              <div key={item.url} className="overflow-hidden rounded-xl [&_.react-tweet-theme]:!my-0">
                <Suspense
                  fallback={
                    <div className="flex h-40 items-center justify-center rounded-xl border border-border/60 bg-card/50 text-sm text-muted-foreground">
                      Loading tweet…
                    </div>
                  }
                >
                  <PreLaunchTweetEmbed id={tweetId} />
                </Suspense>
              </div>
            );
          }

          /* ── Rich card (blog / article / video) ─────────── */
          return (
            <a
              key={item.url}
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring pharos-interactive-card group flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/50"
            >
              {item.image && (
                <div className="relative aspect-[1200/630] w-full overflow-hidden bg-muted/30">
                  <Image
                    src={item.image}
                    alt={item.title}
                    fill
                    sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                    className="object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                    unoptimized
                  />
                </div>
              )}
              <div className="flex flex-1 flex-col gap-1.5 p-4">
                <p className="text-sm font-semibold text-foreground">{item.title}</p>
                {item.description && (
                  <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.description}</p>
                )}
                <div className="mt-auto flex items-center gap-1.5 pt-1 text-2xs text-muted-foreground/70">
                  <ContentTypeIcon type={item.type} />
                  <span>{item.source ?? item.type}</span>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

function PlannedProfileCard({ coin }: { coin: StablecoinMeta }) {
  const chains = [...new Set(coin.contracts?.map((c) => c.chain) ?? [])].map(chainName);
  const jurisdiction = coin.jurisdiction?.regulator
    ? `${coin.jurisdiction.country} (${coin.jurisdiction.regulator})`
    : coin.jurisdiction?.country;
  const facts: FactGridItem[] = [
    { key: "peg", label: "Peg", value: PEG_LABELS_SHORT[coin.flags.pegCurrency] ?? coin.flags.pegCurrency, valueStyle: "text" },
    { key: "backing", label: "Backing", value: BACKING_LABELS[coin.flags.backing] ?? coin.flags.backing, valueStyle: "text" },
    { key: "governance", label: "Governance", value: GOVERNANCE_LABELS[coin.flags.governance] ?? coin.flags.governance, valueStyle: "text" },
    { key: "jurisdiction", label: "Jurisdiction", value: jurisdiction ?? "Not recorded", valueStyle: "text" },
    ...(coin.flags.yieldBearing ? [{ key: "yield", label: "Yield", value: "Yield-bearing", valueStyle: "text" as const }] : []),
    ...(chains.length > 0 ? [{ key: "chains", label: "Target chains", value: chains.join(", "), valueStyle: "text" as const }] : []),
  ];

  return (
    <RailCard title="Planned profile" ariaLabel="Planned profile">
      <div className="space-y-4 px-4 pb-4">
        <FactGrid items={facts} aria-label="Planned profile" />
        {coin.reserves && coin.reserves.length > 0 ? (
          <div className="space-y-2 border-t border-border/50 pt-3">
            <p className="pharos-label">Planned collateral</p>
            <ul className="space-y-1.5">
              {coin.reserves.map((slice) => (
                <li key={slice.name} className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="min-w-0 break-words text-foreground">{slice.name}</span>
                  <span className="pharos-numeric shrink-0 text-muted-foreground">{slice.pct}%</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </RailCard>
  );
}

/**
 * Active and pre-launch coins: the existing same-currency sort then ranks the
 * coin's upcoming siblings (other HKD/JPY/KRW launches) ahead of USD majors.
 */
const RELATED_CANDIDATES = CLIENT_TRACKED_STABLECOINS.filter(
  (candidate) => isActiveStablecoinMeta(candidate) || isPreLaunchStablecoinMeta(candidate),
);

function RelatedCard({ coin }: { coin: StablecoinMeta }) {
  const related = getRelatedStablecoins(coin, { candidates: RELATED_CANDIDATES });
  return (
    <RailCard title="Related stablecoins" ariaLabel="Related stablecoins">
      <div className="space-y-3 px-4 pb-4">
        <p className="text-xs text-muted-foreground">
          {related.length > 0
            ? "Tracked stablecoins with a similar governance, backing or peg profile."
            : "No tracked stablecoin shares this profile yet."}
        </p>
        {related.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {related.map((rel) => (
              <Link
                key={rel.id}
                href={buildStablecoinUrl(rel.id)}
                className="pharos-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-border/60 bg-background/50 px-3 py-1.5 text-sm text-foreground transition-colors hover:border-foreground/20 hover:bg-accent lg:min-h-9"
              >
                <StablecoinLogo src={getLogoSrc(logosById, rel.id)} name={rel.name} size={18} />
                <span className="font-mono text-xs font-medium tabular-nums">{rel.symbol}</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </RailCard>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface PreLaunchDetailProps {
  coin: StablecoinMeta;
  logoSrc: string | undefined;
  summary: StablecoinAiSummary | null;
}

/**
 * The pre-launch variant of the stablecoin dossier (server component): the
 * live dossier's identity header, hero, summary, evidence modules and rail,
 * filled with registry launch facts only. Live surfaces are named once in an
 * explicit "Activates at launch" strip, never drawn as empty cards.
 */
export function PreLaunchDetail({ coin, logoSrc, summary }: PreLaunchDetailProps) {
  return (
    <StablecoinDetailIdentityProvider symbol={coin.symbol} logoSrc={logoSrc}>
      <Link
        href="/upcoming/"
        className="pharos-focus-ring mb-2 inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> All upcoming stablecoins
      </Link>
      <PreLaunchIdentityHeader coin={coin} logoSrc={logoSrc} />
      <div className="mt-4 xl:grid xl:grid-cols-[minmax(0,1fr)_22rem] xl:items-start xl:gap-6">
        <div className="min-w-0 space-y-4">
          <div className="pharos-card-shell gap-0 overflow-hidden py-0">
            <PreLaunchChipRail coin={coin} />
            <PreLaunchReadiness coin={coin} />
          </div>
          <EvidenceStateStrip
            id="live-surfaces"
            title="Live surfaces"
            state="pending-launch"
            reason={LIVE_SURFACES}
            density="main"
            headingLevel="h2"
          />
          {summary ? <AiSummary {...summary} /> : null}
          <LaunchPathModule coin={coin} />
          <LaunchQuickAnswers coin={coin} />
          <ActivityModule coin={coin} />
          {coin.featuredContent && coin.featuredContent.length > 0 ? (
            <FeaturedCoverage items={coin.featuredContent} />
          ) : null}
        </div>
        <aside aria-label={`${coin.symbol} profile`} className="mt-4 grid gap-4 md:grid-cols-2 xl:mt-0 xl:grid-cols-1">
          <PlannedProfileCard coin={coin} />
          <KeyLinksCard meta={coin} anchors />
          <RelatedCard coin={coin} />
        </aside>
      </div>
    </StablecoinDetailIdentityProvider>
  );
}
