import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ExternalLink, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { DisclosurePanel } from "@/components/disclosure-panel";
import { FeatureHeroSplit } from "@/components/feature-hero-split";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { FaqSection } from "@/components/faq-section";
import { JsonLdScript } from "@/components/json-ld-script";
import { formatLongDate } from "@shared/lib/format";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { API_REFERENCE_URL } from "@shared/lib/public-api-contract";
import { BLACKLIST_STABLECOINS } from "@shared/types/blacklist";
import { cn } from "@/lib/utils";
import { safeJsonLd } from "@/lib/json-ld";
import {
  COMPANION_FEATURES,
  COMPUTED_FEATURES,
  DATA_PIPELINE_STEPS,
  DATA_SOURCE_GROUPS,
  getAboutFaqItems,
  getTrackedFeatures,
  TEAM_MEMBERS,
  type AboutFeatureItem,
} from "@/lib/about-content";
import { MEDIA_APPEARANCES, WALKTHROUGH_APPEARANCES, type MediaAppearance } from "@/lib/media-appearances";
import {
  PRINCIPLES_AI_POLICY,
  PRINCIPLES_AXIOMS,
  PRINCIPLES_CORRECTIONS,
  type PrincipleAxiom,
} from "@/lib/about-principles-content";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { BLUECHIP_GATES, BLUECHIP_LEDE, BLUECHIP_REFUSALS, BLUECHIP_WHAT_IT_MEANS } from "./bluechip-content";
import {
  ACTIVE_TOKENIZED_FUND_COUNT,
  ACTIVE_VARIANT_STABLECOIN_COUNT,
  CORE_AGGREGATE_STABLECOIN_COUNT,
  DEAD_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";
import { HEADLINE_STABLECOIN_COUNT } from "@/lib/universe-vocabulary";
import { isLaunchedAwaitingData } from "@/lib/pre-launch";
import { PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins/registry";

// Launched rows are live, not upcoming: /upcoming/ and /learn/mechanisms/ leave
// them out too, so About counts the same upcoming set.
const UPCOMING_STABLECOIN_COUNT = PRE_LAUNCH_STABLECOINS.filter((coin) => !isLaunchedAwaitingData(coin)).length;

const INLINE_PROSE_LINK_CLASS =
  "pharos-prose-link text-foreground hover:text-brand-accent-text";

// Intentionally extends pharos-prose-link with inline-flex/gap-1 for icon-paired links (ExternalLink icon)
// and brand-accent hover for visual differentiation.
const INLINE_EXTERNAL_LINK_CLASS =
  "pharos-prose-link inline-flex items-center gap-1 text-foreground hover:text-brand-accent-text";

export const ABOUT_METADATA_TITLE = "About Pharos: Independent Stablecoin Risk Analytics";
export const ABOUT_METADATA_DESCRIPTION =
  "About Pharos: open stablecoin analytics for peg tracking, safety scores, liquidity, freeze monitoring, methodology, data sources, and failed-coin archives.";

const ABOUT_PAGE_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "AboutPage",
  "@id": `${SITE_ORIGIN}/about/#about-page`,
  name: "About Pharos",
  url: `${SITE_ORIGIN}/about/`,
  description: ABOUT_METADATA_DESCRIPTION,
  inLanguage: "en",
  isPartOf: { "@id": `${SITE_ORIGIN}#website` },
  about: { "@id": `${SITE_ORIGIN}#organization` },
  mainEntity: { "@id": `${SITE_ORIGIN}#organization` },
  publisher: { "@id": `${SITE_ORIGIN}#organization` },
  mentions: [
    {
      "@type": "WebAPI",
      "@id": `${SITE_ORIGIN}/api/#webapi`,
      name: "Pharos API",
      url: API_REFERENCE_URL,
    },
    {
      "@type": "DataCatalog",
      "@id": `${SITE_ORIGIN}/api/#data-catalog`,
      name: "Pharos public data artifacts",
      url: API_REFERENCE_URL,
    },
    {
      "@type": "WebPage",
      "@id": `${SITE_ORIGIN}/coverage/#coverage`,
      name: "Coverage Matrix",
      url: `${SITE_ORIGIN}/coverage/`,
    },
    {
      "@type": "WebPage",
      "@id": `${SITE_ORIGIN}/methodology/#methodology`,
      name: "Methodology",
      url: `${SITE_ORIGIN}/methodology/`,
    },
    {
      "@type": "WebPage",
      "@id": `${SITE_ORIGIN}/about/#principles`,
      name: "Pharos Principles",
      url: `${SITE_ORIGIN}/about/#principles`,
    },
    {
      "@type": "WebPage",
      "@id": `${SITE_ORIGIN}/about/#editorial-ai-policy`,
      name: "Editorial Policy",
      url: `${SITE_ORIGIN}/about/#editorial-ai-policy`,
    },
    {
      "@type": "WebPage",
      "@id": `${SITE_ORIGIN}/funding/#funding`,
      name: "Funding",
      url: `${SITE_ORIGIN}/funding/`,
    },
  ],
} as const;

const ABOUT_JUMP_ANCHORS = [
  { href: "#principles", label: "Principles" },
  { href: "#team", label: "Team" },
  { href: "#coverage", label: "Coverage" },
  { href: "#data-pipeline", label: "Data pipeline" },
  { href: "#contact", label: "Contact" },
] as const;

// Each group leads with a one-line summary; the exhaustive vendor list (and its
// evidence caveats) sits behind a native disclosure so the section stays
// scannable while remaining in static HTML.
function PipelineSources() {
  const lastIndex = DATA_SOURCE_GROUPS.length - 1;
  const hasOddLastItem = DATA_SOURCE_GROUPS.length % 2 === 1;

  return (
    <dl className="grid gap-3 md:grid-cols-2">
      {DATA_SOURCE_GROUPS.map((group, index) => (
        <div
          key={group.label}
          className={cn(
            "pharos-inset flex min-w-0 flex-col gap-1.5 p-4",
            hasOddLastItem && index === lastIndex && "md:col-span-2",
          )}
        >
          <dt className="pharos-label text-foreground">{group.label}</dt>
          <dd className="space-y-2 text-xs leading-relaxed text-muted-foreground">
            <p>{group.summary}</p>
            <DisclosurePanel
              variant="plain"
              chevronPosition="end"
              summary="Full source list"
              contentClassName="space-y-1.5 border-t border-border/50 pt-2"
            >
              <p className="text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">{group.sources}</p>
              {"documentation" in group ? (
                <p className="text-xs">
                  <a className={INLINE_PROSE_LINK_CLASS} href={group.documentation.href}>
                    {group.documentation.label}
                  </a>
                </p>
              ) : null}
            </DisclosurePanel>
          </dd>
        </div>
      ))}
    </dl>
  );
}

function AboutFeatureTile({ item }: { item: AboutFeatureItem }) {
  const tileClassName = cn(
    "pharos-inset flex h-full flex-col gap-3 p-4",
    item.href && "pharos-focus-ring pharos-interactive-card group",
  );

  const content = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/75">
          <item.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </div>
        {!item.href && item.metaLabel ? (
          <span className="pharos-label rounded-md border border-border/50 bg-muted/40 px-2 py-0.5">
            {item.metaLabel}
          </span>
        ) : null}
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{item.title}</h3>
        <div className="text-xs leading-relaxed text-muted-foreground">{item.description}</div>
      </div>
      {item.href ? (
        <span className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
          {item.linkLabel ?? (item.external ? "Open source" : "Open route")}
          {item.external ? (
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </span>
      ) : null}
    </>
  );

  if (!item.href) {
    return <article className={tileClassName}>{content}</article>;
  }

  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noopener noreferrer" className={tileClassName}>
        {content}
      </a>
    );
  }

  return (
    <Link href={item.href} className={tileClassName}>
      {content}
    </Link>
  );
}

function appearanceDateLabel(date: string): string {
  return formatLongDate(new Date(`${date}T00:00:00Z`), { utc: true });
}

function HostLogo({ appearance, size }: { appearance: MediaAppearance; size: number }) {
  return (
    <Image
      src={appearance.hostLogoSrc}
      alt={`${appearance.host} logo`}
      width={size}
      height={size}
      className="shrink-0 overflow-hidden rounded-md border border-border/60 bg-background/80"
    />
  );
}

function FeaturedAppearance({ appearance }: { appearance: MediaAppearance }) {
  return (
    <div className="pharos-inset p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <HostLogo appearance={appearance} size={56} />
        <div className="min-w-0 space-y-3">
          <div className="space-y-1">
            <p className="pharos-label">Featured</p>
            <p className="text-base font-semibold tracking-tight text-foreground">{appearance.title}</p>
            <p className="pharos-meta">
              {appearance.host} &middot;{" "}
              <time dateTime={appearance.date}>{appearanceDateLabel(appearance.date)}</time>
            </p>
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{appearance.description}</p>
          <Button asChild variant="outline" size="sm">
            <a href={appearance.href} target="_blank" rel="noopener noreferrer">
              Watch the broadcast
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

function AppearanceCard({ appearance }: { appearance: MediaAppearance }) {
  const isWalkthrough = WALKTHROUGH_APPEARANCES.includes(appearance);

  return (
    <a
      href={appearance.href}
      target="_blank"
      rel="noopener noreferrer"
      className="pharos-inset pharos-interactive-card pharos-focus-ring group flex h-full flex-col gap-3 p-4"
    >
      <div className="flex items-start gap-3">
        <HostLogo appearance={appearance} size={40} />
        <div className="min-w-0 space-y-0.5">
          <p className="pharos-meta">
            {appearance.host} &middot;{" "}
            <time dateTime={appearance.date}>{appearanceDateLabel(appearance.date)}</time>
          </p>
          {isWalkthrough ? (
            <p className="pharos-label">
              Full walkthrough
              {appearance.durationMinutes ? (
                <>
                  {" "}
                  &middot; <span className="pharos-numeric">{appearance.durationMinutes} min</span>
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="inline-flex items-start gap-1.5 text-sm font-semibold leading-snug text-foreground">
          <span>{appearance.title}</span>
          <ExternalLink
            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
            aria-hidden="true"
          />
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">{appearance.description}</p>
      </div>
    </a>
  );
}

/** Renders a principle body with its declared inline links. */
function PrincipleBody({ principle }: { principle: PrincipleAxiom }) {
  const links = principle.links ?? [];
  if (links.length === 0) return <>{principle.body}</>;

  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const link of links) {
    const start = principle.body.indexOf(link.text, cursor);
    if (start < 0) continue;
    parts.push(principle.body.slice(cursor, start));
    parts.push(
      <a
        key={`${link.href}:${start}`}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        className="pharos-prose-link whitespace-nowrap text-foreground hover:text-brand-accent-text"
      >
        {link.text}
      </a>,
    );
    cursor = start + link.text.length;
  }
  parts.push(principle.body.slice(cursor));
  return <>{parts}</>;
}

function RouteBoardSection({
  id,
  kicker,
  heading,
  description,
  items,
  footer,
}: {
  id?: string;
  kicker: string;
  heading: string;
  description: string;
  items: readonly AboutFeatureItem[];
  footer?: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24">
      <Card variant="shell" className="gap-6 py-6">
        <CardHeader className="px-5 sm:px-6" kicker={kicker} heading={heading} description={description} />
        <CardContent className="px-5 sm:px-6">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <AboutFeatureTile key={item.title} item={item} />
            ))}
          </div>
        </CardContent>
        {footer ? (
          <CardFooter className="border-t border-border/60 px-5 pt-5 sm:px-6">{footer}</CardFooter>
        ) : null}
      </Card>
    </section>
  );
}

export function AboutPageContent() {
  const trackedFeatures = getTrackedFeatures({
    activeStablecoins: CORE_AGGREGATE_STABLECOIN_COUNT,
    deadStablecoins: DEAD_STABLECOIN_COUNT,
    preLaunchStablecoins: UPCOMING_STABLECOIN_COUNT,
  });
  const faqItems = getAboutFaqItems({
    activeStablecoins: CORE_AGGREGATE_STABLECOIN_COUNT,
    deadStablecoins: DEAD_STABLECOIN_COUNT,
  });
  const featuredAppearance = MEDIA_APPEARANCES.find((appearance) => appearance.featured);
  const otherAppearances = MEDIA_APPEARANCES.filter((appearance) => appearance !== featuredAppearance);

  const universeRows: readonly { label: string; value: string | number }[] = [
    { label: "Core", value: CORE_AGGREGATE_STABLECOIN_COUNT },
    { label: "Variants", value: ACTIVE_VARIANT_STABLECOIN_COUNT },
  ];
  const alongsideRows: readonly { label: string; value: string | number }[] = [
    { label: "Tokenized funds", value: ACTIVE_TOKENIZED_FUND_COUNT },
    { label: "Upcoming", value: UPCOMING_STABLECOIN_COUNT },
    { label: "Sources", value: "50+" },
  ];

  const operatingPrincipleIds = [
    "independence",
    "risk-over-price",
    "dependency-is-contagion",
    "methodology-versioned",
    "open-code-open-data",
  ];
  const operatingPrinciples = operatingPrincipleIds.map((id) => {
    const principle = PRINCIPLES_AXIOMS.find((axiom) => axiom.id === id);
    if (!principle) {
      throw new Error(`Unknown operating principle id: ${id}`);
    }
    return principle;
  });

  const whyKeyLinks = [
    {
      href: "/funding/",
      label: "Funding ledger",
      description: "Operating costs, community donations, and in-kind sponsors.",
    },
    {
      href: "/docs/listing-policy/",
      label: "Listing policy",
      description: "Eligibility rules, review holds, and lifecycle transitions.",
    },
    {
      href: "/docs/",
      label: "Documentation archive",
      description: "Technical specifications, pipeline contracts, and Markdown twins.",
    },
    {
      href: "/cemetery/",
      label: "Stablecoin cemetery",
      description: `${DEAD_STABLECOIN_COUNT} archived defunct coins with causes and obituaries.`,
    },
  ] as const;

  return (
    <FeaturePageShell
      breadcrumbName="About Pharos"
      path="/about/"
      title="About Pharos"
      leadParagraphs={["Most trackers show price. Pharos shows risk."]}
      preface={<JsonLdScript json={safeJsonLd(ABOUT_PAGE_JSON_LD)} />}
    >
      <div className="space-y-10">
        <section aria-labelledby="about-lede">
          <FeatureHeroSplit
            ariaLabel="About Pharos overview"
            beamLabel="Active stablecoins"
            beamValue={HEADLINE_STABLECOIN_COUNT}
            universe={
              <p className="pharos-meta">
                Core, variants, and review-hold listings; tokenized funds tracked separately.
              </p>
            }
            subKicker="Universe composition"
            sub={
              <div className="space-y-3">
                <dl className="divide-y divide-border/50">
                  {universeRows.map((row) => (
                    <div key={row.label} className="flex items-baseline justify-between gap-3 py-1.5">
                      <dt className="text-sm text-muted-foreground">{row.label}</dt>
                      <dd className="pharos-numeric text-sm font-semibold text-foreground">{row.value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="space-y-1.5 border-t border-border/50 pt-3">
                  <p className="pharos-label">Tracked alongside</p>
                  <dl className="divide-y divide-border/50">
                    {alongsideRows.map((row) => (
                      <div key={row.label} className="flex items-baseline justify-between gap-3 py-1.5">
                        <dt className="text-sm text-muted-foreground">{row.label}</dt>
                        <dd className="pharos-numeric text-sm font-semibold text-foreground">{row.value}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              </div>
            }
            footer={
              <nav aria-label="About page sections" className="flex flex-wrap items-center gap-2">
                <span className="pharos-label mr-1">On this page</span>
                {ABOUT_JUMP_ANCHORS.map((anchor) => (
                  <a key={anchor.href} href={anchor.href} className="pharos-control-pill pharos-focus-ring">
                    {anchor.label}
                  </a>
                ))}
              </nav>
            }
          >
            <div className="flex h-full flex-col justify-between gap-6 p-5 sm:p-6 lg:p-7">
              <div className="space-y-3">
                <p
                  id="about-lede"
                  className="pharos-display text-xl font-bold leading-snug tracking-tight text-foreground sm:text-2xl"
                >
                  Every stablecoin makes two promises at once: that it will redeem at par, and that it can be redeemed
                  at all. Pharos watches both across active stablecoins, tracked variants, tokenized funds, and the
                  chains and reserves beneath them so desks, treasuries, and researchers can read the peg the way
                  navigators read weather.
                </p>
                <p className="pharos-meta">
                  Edited by TokenBrice &middot; Engineered with Claude &amp; Codex &middot; MIT
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild variant="default" size="sm">
                  <Link href="/">
                    Open dashboard
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/safety-scores/">Safety Scores</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/coverage/">Coverage Matrix</Link>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <Link href="/methodology/">Methodology</Link>
                </Button>
              </div>
            </div>
          </FeatureHeroSplit>
        </section>

        <section className="scroll-mt-24 space-y-5 border-t border-border/60 pt-8">
          <div className="space-y-1.5">
            <p className="pharos-label">Why it exists</p>
            <h2 className="pharos-display text-2xl font-bold tracking-tight text-foreground">Why Pharos?</h2>
          </div>
          <div className="grid gap-8 lg:grid-cols-[minmax(0,1.65fr)_minmax(18rem,1fr)] lg:items-start">
            <div className="space-y-3.5 text-sm leading-relaxed text-muted-foreground">
              <p>
                The data needed to evaluate stablecoins is scattered, inconsistent, or buried behind paywalls. Worse,
                marketing claims rarely match reality: a &quot;decentralized&quot; stablecoin may rely entirely on
                centralized collateral, an issuer can freeze balances without warning, and a major stablecoin&apos;s
                failure transmits stress to dozens of derivatives that looked independent in isolation.
              </p>
              <p>
                Across the active catalog, {UPCOMING_STABLECOIN_COUNT} upcoming launches, and {DEAD_STABLECOIN_COUNT}{" "}
                dead coins, Pharos scores the core universe with honest governance classification, transitive dependency
                scoring, and live reserve composition where a reviewed adapter exists. Real-time depeg detection, freeze
                monitoring across {BLACKLIST_STABLECOINS.length} stablecoins, and a 30-minute ecosystem-wide stability
                index surface stress as it builds, before it reaches the headlines.
              </p>
              <p>
                When a tracked stablecoin effectively dies (issuer abandonment, supply trending to zero, irrecoverable
                depeg, regulatory shutdown), Pharos freezes it rather than deletes it, and surfaces it in the{" "}
                <Link href="/cemetery/" className={INLINE_PROSE_LINK_CLASS}>
                  cemetery
                </Link>{" "}
                with an obituary and an archived detail page.
              </p>
              <p>
                Pharos is a public good. The dashboard stays free, the code is open source, and sustainability comes
                from community support, in-kind infrastructure sponsorships, and{" "}
                <Link href="/api/" className={INLINE_PROSE_LINK_CLASS}>
                  paid API plans
                </Link>{" "}
                for production teams.{" "}
                <Link href="/funding/" className={INLINE_PROSE_LINK_CLASS}>
                  See the funding ledger
                </Link>
                .
              </p>
              <p>
                For asset eligibility and lifecycle decisions, read the{" "}
                <Link href="/docs/listing-policy/" className={INLINE_PROSE_LINK_CLASS}>
                  listing policy
                </Link>
                . For methodology and API references, use the{" "}
                <Link href="/docs/" className={INLINE_PROSE_LINK_CLASS}>
                  documentation archive
                </Link>
                .
              </p>
            </div>
            <aside aria-label="Governance and records" className="lg:border-l lg:border-border/60 lg:pl-6">
              <p className="pharos-label">Governance &amp; records</p>
              <ul className="mt-3 divide-y divide-border/50 border-t border-border/50">
                {whyKeyLinks.map((item) => (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className="pharos-focus-ring group flex items-start justify-between gap-3 rounded-sm py-3 transition-colors"
                    >
                      <span className="min-w-0 space-y-0.5">
                        <span className="block text-sm font-medium text-foreground group-hover:text-brand-accent-text">
                          {item.label}
                        </span>
                        <span className="block text-xs leading-snug text-muted-foreground">{item.description}</span>
                      </span>
                      <ArrowRight
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                        aria-hidden="true"
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </section>

        <section id="principles" className="scroll-mt-24">
          <Card variant="shell" className="gap-6 py-6">
            <CardHeader
              className="px-5 sm:px-6"
              kicker="Operating stance"
              heading="Principles, AI policy, and corrections"
              description="The editorial and technical standards behind Pharos coverage, scoring, and public accountability."
            />
            <CardContent className="space-y-6 px-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              <div className="grid gap-3 md:grid-cols-6">
                {operatingPrinciples.map((axiom, index) => (
                  <article
                    key={axiom.id}
                    className={cn(
                      "pharos-inset flex flex-col gap-1.5 p-4",
                      index < 2 ? "md:col-span-3" : "md:col-span-2",
                    )}
                  >
                    <div className="flex items-baseline gap-2">
                      <span className="pharos-numeric text-xs font-semibold text-muted-foreground">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <h3 className="text-sm font-semibold tracking-tight text-foreground">{axiom.title}</h3>
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      <PrincipleBody principle={axiom} />
                    </p>
                  </article>
                ))}
              </div>
              <div className="grid gap-4 border-t border-border/60 pt-6 md:grid-cols-2">
                <div id="editorial-ai-policy" className="pharos-inset scroll-mt-24 space-y-1.5 p-4">
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">{PRINCIPLES_AI_POLICY.title}</h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">{PRINCIPLES_AI_POLICY.body}</p>
                </div>
                <div id="corrections-policy" className="pharos-inset scroll-mt-24 space-y-1.5 p-4">
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    {PRINCIPLES_CORRECTIONS.title}
                  </h3>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {PRINCIPLES_CORRECTIONS.body}{" "}
                    <Link href="/funding/" className={INLINE_PROSE_LINK_CLASS}>
                      See the funding ledger
                    </Link>{" "}
                    for the inbound side of the same accountability.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section id="team" className="scroll-mt-24">
          <Card variant="shell" className="gap-6 py-6">
            <CardHeader className="px-5 sm:px-6" kicker="The team" heading="Who is building Pharos?" />
            <CardContent className="px-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] lg:items-start">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-2">
                  {TEAM_MEMBERS.map((member) => (
                    <figure key={member.name} className="pharos-inset flex items-center gap-3 p-3">
                      <Image
                        src={member.imageSrc}
                        alt={member.name}
                        width={48}
                        height={48}
                        className="h-12 w-12 shrink-0 rounded-md border border-border/50 bg-background/80 object-cover"
                      />
                      <figcaption className="min-w-0 space-y-0.5">
                        <p className="truncate text-sm font-semibold text-foreground">{member.name}</p>
                        <p className="pharos-label truncate">{member.role}</p>
                      </figcaption>
                    </figure>
                  ))}
                </div>
                <div className="space-y-3">
                  <p>
                    <a
                      href="https://tokenbrice.xyz/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={INLINE_EXTERNAL_LINK_CLASS}
                    >
                      TokenBrice
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>{" "}
                    created Pharos and leads product direction, scoring methodology, and the data pipeline. TokenBrice
                    also works on Polaris, and Polaris-related coverage, like everything else on Pharos, remains purely
                    data-driven.{" "}
                    <a
                      href="https://x.com/Ikebillion_"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={INLINE_EXTERNAL_LINK_CLASS}
                    >
                      Ike
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>{" "}
                    drives growth and communications. Most of the codebase is written and maintained by{" "}
                    <a
                      href="https://www.anthropic.com/claude-code"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={INLINE_EXTERNAL_LINK_CLASS}
                    >
                      Claude
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>{" "}
                    and{" "}
                    <a
                      href="https://openai.com/codex/"
                      target="_blank"
                      rel="noopener noreferrer"
                      className={INLINE_EXTERNAL_LINK_CLASS}
                    >
                      Codex
                      <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                    , from the worker pipeline and scoring engine to the frontend and daily digest.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section id="media" className="scroll-mt-24">
          <Card variant="shell" className="gap-6 py-6">
            <CardHeader
              className="px-5 sm:px-6"
              kicker="In the wild"
              heading="Pharos in the media"
              description='Prefer to watch? Appearances marked "Full walkthrough" are unscripted sessions of someone driving the dashboard live, hosted elsewhere.'
            />
            <CardContent className="space-y-4 px-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              {featuredAppearance ? <FeaturedAppearance appearance={featuredAppearance} /> : null}
              {otherAppearances.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-3">
                  {otherAppearances.map((appearance) => (
                    <AppearanceCard key={appearance.href} appearance={appearance} />
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </section>

        <RouteBoardSection
          id="coverage"
          kicker="Coverage"
          heading="What Pharos tracks"
          description="The raw monitoring layer: live supply, peg behavior, blacklist activity, liquidity depth, and chain-level flow data pulled from 50+ sources into one operating picture."
          items={trackedFeatures}
        />

        <RouteBoardSection
          kicker="Signals"
          heading="What Pharos computes"
          description="The analysis layer: models and forecasts Pharos computes from its own pipeline, including a 0-100 market-regime gauge for stablecoins, dependency-capped safety grades, and forward-looking depeg pressure."
          items={COMPUTED_FEATURES}
          footer={
            <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Telegram alerts cover DEWS state changes, depeg events, and safety grade changes.
              </p>
              <Button asChild variant="outline" size="sm">
                <Link href="/pharoswatchbot/">
                  Open @PharosWatchBot
                  <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </Button>
            </div>
          }
        />

        <section aria-label="Companion experiences">
          <Card variant="shell" className="gap-4 py-5">
            <CardHeader
              className="px-5 sm:px-6"
              kicker="Immersive data visualization"
              heading="Companion experiences"
              description="Sibling surfaces hosted at separate origins using the same public Pharos API."
            />
            <CardContent className="px-5 sm:px-6">
              {COMPANION_FEATURES.map((item) => (
                <a
                  key={item.title}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pharos-inset pharos-interactive-card pharos-focus-ring group flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-5"
                >
                  <div className="flex items-start gap-3.5">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border/60 bg-background/75">
                      <item.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </div>
                    <div className="min-w-0 space-y-1">
                      <h3 className="text-sm font-semibold tracking-tight text-foreground">{item.title}</h3>
                      <div className="text-xs leading-relaxed text-muted-foreground">{item.description}</div>
                    </div>
                  </div>
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
                    {item.linkLabel ?? "Open source"}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </span>
                </a>
              ))}
            </CardContent>
          </Card>
        </section>

        <section className="scroll-mt-24">
          <Card variant="shell" className="gap-6 py-6">
            <CardHeader
              className="px-5 sm:px-6"
              kicker="Governance lens"
              heading="Classification"
              description="Pharos classifies stablecoins by actual infrastructure dependency, not marketing claims."
            />
            <CardContent className="px-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              <div className="grid gap-3 md:grid-cols-3">
                <div className="pharos-inset space-y-1.5 p-4">
                  <p className="text-sm font-semibold text-foreground">CeFi</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Fully centralized issuance, custody, and transfer controls.
                  </p>
                </div>
                <div className="pharos-inset space-y-1.5 p-4">
                  <p className="text-sm font-semibold text-foreground">CeFi-Dependent</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Decentralized infrastructure, but reliant on centralized collateral or peg{" "}
                    <Link href="/learn/mechanisms/" className={INLINE_PROSE_LINK_CLASS}>
                      mechanisms
                    </Link>
                    .
                  </p>
                </div>
                <div className="pharos-inset space-y-1.5 p-4">
                  <p className="text-sm font-semibold text-foreground">DeFi</p>
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Fully on-chain architecture with no centralized custody dependency.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section id="bluechip" className="scroll-mt-24">
          <Card variant="shell" className="gap-6 py-6">
            <CardHeader
              className="px-5 sm:px-6"
              kicker="Editorial designation"
              heading="Pharos Bluechip"
              actions={
                <span className="inline-flex items-center rounded-full border border-state-warn bg-state-warn-subtle px-2.5 py-1 text-xs font-medium text-state-warn-strong">
                  Roster suspended &middot; floor under review
                </span>
              }
            />
            <CardContent className="space-y-6 px-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              <div className="space-y-3">
                <p className="text-foreground/90">{BLUECHIP_LEDE}</p>
                <div className="pharos-subtle-band rounded-lg text-xs leading-relaxed text-muted-foreground">
                  <p>
                    <span className="font-semibold text-foreground">Roster suspended</span> while the grade floor is
                    under review. It resumes under the same rule: the live intersection of external Bluechip A-tier
                    ratings and Pharos A-tier report cards, current-state rather than historical. Bluechip rides the
                    Safety Score methodology ({SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}) and is re-derived, never
                    grandfathered, when a floor changes. The per-coin badge still links to the external Bluechip report.
                  </p>
                </div>
                {BLUECHIP_WHAT_IT_MEANS.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
              <div className="grid gap-6 border-t border-border/60 pt-6 lg:grid-cols-2 lg:items-start">
                <div className="space-y-3">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold tracking-tight text-foreground">The gates</h3>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Each gate is independent. A coin clears Bluechip only when every gate clears at the same moment,
                      and only while it continues to do so.
                    </p>
                  </div>
                  <ol className="divide-y divide-border/60 border-y border-border/60">
                    {BLUECHIP_GATES.map((gate, index) => (
                      <li key={gate.id} className="grid gap-1 py-3 sm:grid-cols-[2.25rem_minmax(0,1fr)] sm:gap-3">
                        <span className="pharos-numeric text-xs font-semibold text-muted-foreground">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <p className="text-xs leading-relaxed text-muted-foreground">
                          <span className="font-semibold text-foreground">{gate.title}.</span> {gate.body}
                        </p>
                      </li>
                    ))}
                  </ol>
                </div>
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    What Bluechip refuses to grant
                  </h3>
                  <ul className="divide-y divide-border/60 border-y border-border/60">
                    {BLUECHIP_REFUSALS.map((entry) => (
                      <li key={entry.title} className="py-3 text-xs leading-relaxed text-muted-foreground">
                        <span className="font-semibold text-foreground">{entry.title}.</span> {entry.body}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 pt-4 text-xs">
                <Link href="/methodology/#safety-scores-methodology" className={INLINE_PROSE_LINK_CLASS}>
                  Safety Scores methodology
                </Link>
                <span aria-hidden="true">&middot;</span>
                <Link href="/methodology/scoring-changelog/" className={INLINE_PROSE_LINK_CLASS}>
                  Scoring changelog
                </Link>
                <span aria-hidden="true">&middot;</span>
                <Link href="/methodology/#def-bluechip" className={INLINE_PROSE_LINK_CLASS}>
                  Definition
                </Link>
              </p>
            </CardContent>
          </Card>
        </section>

        <section id="data-pipeline" className="scroll-mt-24">
          <Card variant="shell" className="gap-6 py-6">
            <CardHeader
              className="px-5 sm:px-6"
              kicker="Source flow"
              heading="Data pipeline"
              description="All data is fetched server-side by a Cloudflare Worker and cached in D1. The browser never calls external APIs directly."
            />
            <CardContent className="space-y-6 px-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              <div className="space-y-2.5">
                <p className="pharos-label">Processing path</p>
                <ol className="grid gap-3 md:grid-cols-3">
                  {DATA_PIPELINE_STEPS.map((step) => (
                    <li
                      key={step.step}
                      aria-label={step.ariaLabel}
                      className="pharos-inset flex flex-col gap-2 p-4"
                    >
                      <div className="flex items-baseline gap-2">
                        <span aria-hidden="true" className="pharos-numeric text-xs font-semibold text-muted-foreground">
                          {String(step.step).padStart(2, "0")}
                        </span>
                        <p className="text-sm font-semibold text-foreground">{step.title}</p>
                      </div>
                      <p className="text-xs leading-relaxed text-muted-foreground">{step.description}</p>
                    </li>
                  ))}
                </ol>
              </div>
              <div className="space-y-3 border-t border-border/60 pt-6">
                <p className="pharos-label">Source groups</p>
                <PipelineSources />
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="scroll-mt-24">
          <Card variant="shell" className="gap-4 py-6">
            <CardHeader
              className="px-5 sm:px-6"
              kicker="Scoring details"
              heading="Methodology"
              actions={
                <Button asChild variant="outline" size="sm">
                  <Link href="/methodology/">
                    Read the full methodology
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                </Button>
              }
            />
            <CardContent className="px-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              <p>
                Pharos Safety Score grades stablecoins across Backing, Exit, and Economic Control, then applies peg
                behavior, deployment adjustments, and binding caps. The methodology page covers the full grading
                formula, peg score computation, DEX liquidity scoring, and dependency propagation.
              </p>
            </CardContent>
          </Card>
        </section>

        <FaqSection items={faqItems} title="About Pharos FAQ" includeJsonLd />

        <aside className="pharos-subtle-band text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Disclaimer:</span> Pharos is an informational tool, not a
            licensed financial advisor. Nothing on this site constitutes financial, investment, or legal advice. All
            data is provided as-is and may contain errors or delays. Always do your own research and consult a qualified
            professional before making financial decisions.
          </p>
        </aside>

        <section id="contact" className="scroll-mt-24">
          <Card variant="shell" className="gap-5 py-6">
            <CardHeader className="px-5 sm:px-6" kicker="Reach out" heading="Get in touch" />
            <CardContent className="space-y-4 px-5 text-sm leading-relaxed text-muted-foreground sm:px-6">
              <p>
                Pharos code and data are MIT-licensed. If you spot a bad data point, want a stablecoin added, or want to
                understand how something is computed, open the code or reach out directly.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="outline" size="sm">
                  <a href="https://github.com/TokenBrice/pharos-watch" target="_blank" rel="noopener noreferrer">
                    <GitBranch className="h-3.5 w-3.5" aria-hidden="true" />
                    View on GitHub
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href="https://x.com/PharosWatch" target="_blank" rel="noopener noreferrer">
                    @PharosWatch
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm">
                  <a href="https://tokenbrice.xyz/" target="_blank" rel="noopener noreferrer">
                    tokenbrice.xyz
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Press and research enquiries:{" "}
                <a href="mailto:me@tokenbrice.com" className={INLINE_PROSE_LINK_CLASS}>
                  me@tokenbrice.com
                </a>
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </FeaturePageShell>
  );
}
