import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ExternalLink, GitBranch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FaqSection } from "@/components/faq-section";
import { formatLongDate } from "@shared/lib/format";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { cn } from "@/lib/utils";
import { safeJsonLd } from "@/lib/json-ld";
import {
  COMPANION_FEATURES,
  COMPUTED_FEATURES,
  DATA_PIPELINE_STEPS,
  DATA_SOURCE_GROUPS,
  getAboutLeadParagraphs,
  getAboutFaqItems,
  getTrackedFeatures,
  TEAM_MEMBERS,
  type AboutFeatureItem,
} from "@/lib/about-content";
import { MEDIA_APPEARANCES, type MediaAppearance } from "@/lib/media-appearances";
import { PRINCIPLES_AI_POLICY, PRINCIPLES_AXIOMS, PRINCIPLES_CORRECTIONS } from "@/lib/about-principles-content";
import {
  ACTIVE_STABLE_VALUE_INVESTMENT_COUNT,
  ACTIVE_VARIANT_STABLECOIN_COUNT,
  CORE_AGGREGATE_STABLECOIN_COUNT,
  DEAD_STABLECOIN_COUNT,
  PRE_LAUNCH_STABLECOIN_COUNT,
  TRACKED_STABLECOIN_COUNT,
} from "@/lib/stablecoin-static-data";

// Intentionally extends pharos-prose-link with inline-flex/gap-1 for icon-paired links (ExternalLink icon)
// and frost-blue hover for visual differentiation. Cannot collapse to pharos-prose-link which has no flex layout.
const INLINE_EXTERNAL_LINK_CLASS =
  "pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-foreground underline underline-offset-4 transition-colors hover:text-frost-blue";
const CTA_BUTTON_CLASS =
  "min-h-11 w-full justify-between rounded-xl border-border/65 bg-background/50 px-4 py-2 whitespace-normal text-left sm:h-9 sm:min-h-0 sm:w-auto sm:justify-center sm:whitespace-nowrap sm:rounded-full";
const TELEGRAM_CTA_BUTTON_CLASS = cn(
  CTA_BUTTON_CLASS,
  "border-transparent bg-foreground text-background hover:bg-foreground/90 hover:text-background dark:bg-foreground dark:text-background dark:hover:bg-foreground/90 dark:hover:text-background",
);
export const ABOUT_METADATA_TITLE = "About Pharos: Independent Stablecoin Risk Monitoring";
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
      "@id": `${SITE_ORIGIN}/about/api/#webapi`,
      name: "Pharos API",
      url: `${SITE_ORIGIN}/about/api/`,
    },
    {
      "@type": "DataCatalog",
      "@id": `${SITE_ORIGIN}/about/api/#data-catalog`,
      name: "Pharos public data artifacts",
      url: `${SITE_ORIGIN}/about/api/`,
    },
    {
      "@type": "WebPage",
      "@id": `${SITE_ORIGIN}/coverage/#coverage`,
      name: "Coverage Matrix",
      url: `${SITE_ORIGIN}/coverage/`,
    },
    {
      "@type": "TechArticle",
      "@id": `${SITE_ORIGIN}/docs/data-pipeline/#tech-article`,
      name: "Data Pipeline",
      url: `${SITE_ORIGIN}/docs/data-pipeline/`,
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

function PipelineSources() {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-1">
      {DATA_SOURCE_GROUPS.map((group) => (
        <div key={group.label} className="space-y-1">
          <dt className="pharos-kicker">{group.label}</dt>
          <dd className="text-xs leading-relaxed text-muted-foreground">{group.sources}</dd>
        </div>
      ))}
    </dl>
  );
}

function AboutFeatureRow({ item }: { item: AboutFeatureItem }) {
  const rowClassName = cn(
    "flex min-h-11 gap-3 rounded-xl px-2 py-4 sm:px-3",
    item.href && "pharos-focus-ring pharos-interactive-card group hover:bg-muted/20",
  );

  const content = (
    <>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75">
        <item.icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <h3 className="text-sm font-semibold tracking-tight text-foreground">{item.title}</h3>
        <div className="text-sm leading-relaxed text-muted-foreground">{item.description}</div>
        {item.href ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground">
            {item.linkLabel ?? (item.external ? "Open source" : "Open route")}
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </span>
        ) : null}
      </div>
    </>
  );

  if (!item.href) {
    return <article className={rowClassName}>{content}</article>;
  }

  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noopener noreferrer" className={rowClassName}>
        {content}
      </a>
    );
  }

  return (
    <Link href={item.href} className={rowClassName}>
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
      className="shrink-0 rounded-lg border border-border/60 bg-background/50"
    />
  );
}

function FeaturedAppearance({ appearance }: { appearance: MediaAppearance }) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/30 p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <HostLogo appearance={appearance} size={56} />
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="pharos-kicker">Featured</p>
            <p className="text-base font-medium text-foreground">{appearance.title}</p>
            <p className="text-xs text-muted-foreground">
              {appearance.host} &middot;{" "}
              <time dateTime={appearance.date}>{appearanceDateLabel(appearance.date)}</time>
            </p>
          </div>
          <p>{appearance.description}</p>
          <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
            <a href={appearance.href} target="_blank" rel="noopener noreferrer">
              Watch the broadcast
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}

function AppearanceRow({ appearance }: { appearance: MediaAppearance }) {
  return (
    <a
      href={appearance.href}
      target="_blank"
      rel="noopener noreferrer"
      className="pharos-focus-ring flex items-start gap-4 rounded-lg px-1 py-4 transition-colors hover:bg-muted/40"
    >
      <HostLogo appearance={appearance} size={40} />
      <div className="space-y-1">
        <p className="inline-flex items-center gap-1 font-medium text-foreground">
          {appearance.title}
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
        </p>
        <p className="text-xs text-muted-foreground">
          {appearance.host} &middot; <time dateTime={appearance.date}>{appearanceDateLabel(appearance.date)}</time>
        </p>
        <p>{appearance.description}</p>
      </div>
    </a>
  );
}

function AboutSection({
  id,
  eyebrow,
  title,
  children,
  contentClassName,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: ReactNode;
  contentClassName?: string;
}) {
  return (
    <Card id={id} className="scroll-mt-24 rounded-xl">
      <CardHeader className="space-y-2">
        <div className="flex items-center gap-3">
          <p className="pharos-kicker">{eyebrow}</p>
          <div className="h-px flex-1 bg-gradient-to-r from-border to-transparent" />
        </div>
        <CardTitle as="h2">{title}</CardTitle>
      </CardHeader>
      <CardContent className={contentClassName}>{children}</CardContent>
    </Card>
  );
}

function AboutFeatureSection({
  eyebrow,
  title,
  intro,
  items,
  footer,
}: {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  items: readonly AboutFeatureItem[];
  footer?: ReactNode;
}) {
  return (
    <AboutSection eyebrow={eyebrow} title={title} contentClassName="space-y-0">
      <div className="-mt-2 mb-4 px-4 text-sm leading-relaxed text-muted-foreground">{intro}</div>
      <div className="divide-y divide-border/60">
        {items.map((item) => (
          <AboutFeatureRow key={item.title} item={item} />
        ))}
      </div>
      {footer ? <div className="mt-4 border-t border-border/60 pt-4">{footer}</div> : null}
    </AboutSection>
  );
}

export function AboutPageContent() {
  const trackedFeatures = getTrackedFeatures({
    activeStablecoins: CORE_AGGREGATE_STABLECOIN_COUNT,
    deadStablecoins: DEAD_STABLECOIN_COUNT,
    preLaunchStablecoins: PRE_LAUNCH_STABLECOIN_COUNT,
  });
  const faqItems = getAboutFaqItems({
    activeStablecoins: CORE_AGGREGATE_STABLECOIN_COUNT,
    deadStablecoins: DEAD_STABLECOIN_COUNT,
  });
  const leadParagraphs = getAboutLeadParagraphs({ activeStablecoins: CORE_AGGREGATE_STABLECOIN_COUNT });
  const featuredAppearance = MEDIA_APPEARANCES.find((appearance) => appearance.featured);
  const otherAppearances = MEDIA_APPEARANCES.filter((appearance) => appearance !== featuredAppearance);
  const heroStats: readonly { label: string; value: string | number }[] = [
    { label: "Core", value: CORE_AGGREGATE_STABLECOIN_COUNT },
    { label: "Variants", value: ACTIVE_VARIANT_STABLECOIN_COUNT },
    { label: "Pre-launch", value: PRE_LAUNCH_STABLECOIN_COUNT },
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

  return (
    <FeaturePageShell
      breadcrumbName="About Pharos"
      path="/about/"
      title="About Pharos"
      leadParagraphs={leadParagraphs}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(ABOUT_PAGE_JSON_LD),
          }}
        />
      }
    >
      <div className="space-y-8">
        <section aria-labelledby="about-lede" className="space-y-6 pb-2">
          <div className="space-y-4">
            <div className="space-y-1">
              <p className="pharos-kicker">Stablecoins tracked</p>
              <p className="pharos-numeric text-[2.1rem] font-semibold leading-none tracking-tight text-frost-blue sm:text-[2.45rem]">
                {TRACKED_STABLECOIN_COUNT}
              </p>
            </div>
            <div className="space-y-3">
              <p
                id="about-lede"
                className="w-full max-w-none text-xl font-semibold leading-[1.18] tracking-tight text-foreground/95 [text-wrap:balance] sm:text-2xl"
              >
                Every stablecoin makes two promises at once: that it will redeem at par, and that it can be redeemed at
                all. Pharos watches both across {CORE_AGGREGATE_STABLECOIN_COUNT} core assets and{" "}
                {ACTIVE_VARIANT_STABLECOIN_COUNT} tracked variants, plus {ACTIVE_STABLE_VALUE_INVESTMENT_COUNT}{" "}
                stable-value investments, and the chains and reserves beneath them so that desks, treasuries, and
                researchers can read the peg the way navigators read weather.
              </p>
              <p className="font-mono text-xs text-muted-foreground/80">
                Edited by TokenBrice &middot; Engineered with Claude &amp; Codex &middot; MIT
              </p>
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
                Watching the peg.
              </p>
            </div>
          </div>
          <dl className="flex flex-wrap gap-x-10 gap-y-4 border-t border-border/60 pt-5">
            {heroStats.map((stat) => (
              <div key={stat.label} className="space-y-1">
                <dt className="pharos-kicker">{stat.label}</dt>
                <dd className="pharos-numeric text-lg font-semibold text-foreground sm:text-xl">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <AboutSection
          eyebrow="Why it exists"
          title="Why Pharos?"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            The data needed to evaluate stablecoins is scattered, inconsistent, or buried behind paywalls. Worse,
            marketing claims rarely match reality: a &quot;decentralized&quot; stablecoin may rely entirely on
            centralized collateral, an issuer can freeze balances without warning, and a major stablecoin&apos;s failure
            transmits stress to dozens of derivatives that looked safe in isolation.
          </p>
          <p>
            Pharos tracks {CORE_AGGREGATE_STABLECOIN_COUNT} core stablecoins and cash equivalents, plus{" "}
            {ACTIVE_VARIANT_STABLECOIN_COUNT} variants, {ACTIVE_STABLE_VALUE_INVESTMENT_COUNT} stable-value investments,{" "}
            {PRE_LAUNCH_STABLECOIN_COUNT} upcoming launches, and {DEAD_STABLECOIN_COUNT} dead ones, then scores the core
            universe with honest governance classification, transitive dependency scoring, and live reserve composition
            where available. Real-time depeg detection, freeze monitoring across 35 stablecoins, and a 30-minute
            ecosystem-wide stability index surface stress as it builds, before it reaches the headlines.
          </p>
          <p>
            When a tracked stablecoin effectively dies (issuer abandonment, supply trending to zero,
            irrecoverable depeg, regulatory shutdown), Pharos freezes it rather than deletes it, and surfaces it
            in the{" "}
            <Link href="/cemetery/" className={INLINE_EXTERNAL_LINK_CLASS}>
              cemetery
            </Link>{" "}
            with an obituary and an archived detail page.
          </p>
          <p>
            Pharos is a public good. The dashboard stays free, the code is open source, and sustainability comes from
            community support plus future paid API access for heavy programmatic usage.{" "}
            <Link href="/funding/" className={INLINE_EXTERNAL_LINK_CLASS}>
              See the funding ledger
            </Link>{" "}
            or{" "}
            <Link href="/start/" className={INLINE_EXTERNAL_LINK_CLASS}>
              get started
            </Link>{" "}
            and make the most of it.
          </p>
          <p>
            For asset eligibility and lifecycle decisions, read the{" "}
            <Link href="/docs/listing-policy/" className={INLINE_EXTERNAL_LINK_CLASS}>
              listing policy
            </Link>
            . For architecture, methodology, and design references, use the{" "}
            <Link href="/docs/" className={INLINE_EXTERNAL_LINK_CLASS}>
              documentation archive
            </Link>
            .
          </p>
        </AboutSection>

        <AboutSection
          id="principles"
          eyebrow="Operating stance"
          title="Principles, AI Policy, and Corrections"
          contentClassName="space-y-5 text-sm leading-relaxed text-muted-foreground"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {operatingPrinciples.map((axiom) => (
              <article key={axiom.title} className="rounded-xl border border-border/60 bg-muted/20 px-4 py-3">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">{axiom.title}</h3>
                <p className="mt-1">{axiom.body}</p>
              </article>
            ))}
          </div>
          <div
            id="editorial-ai-policy"
            className="scroll-mt-24 rounded-xl border border-border/60 bg-muted/20 px-4 py-3"
          >
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{PRINCIPLES_AI_POLICY.title}</h3>
            <p className="mt-1">{PRINCIPLES_AI_POLICY.body}</p>
          </div>
          <div
            id="corrections-policy"
            className="scroll-mt-24 rounded-xl border border-border/60 bg-muted/20 px-4 py-3"
          >
            <h3 className="text-sm font-semibold tracking-tight text-foreground">{PRINCIPLES_CORRECTIONS.title}</h3>
            <p className="mt-1">
              {PRINCIPLES_CORRECTIONS.body}{" "}
              <Link href="/funding/" className={INLINE_EXTERNAL_LINK_CLASS}>
                See the funding ledger
              </Link>{" "}
              for the inbound side of the same accountability.
            </p>
          </div>
        </AboutSection>

        <AboutSection
          eyebrow="The team"
          title="Who Is Building Pharos?"
          contentClassName="grid gap-4 text-sm leading-relaxed text-muted-foreground lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-5"
        >
          <div className="flex flex-wrap items-start gap-4">
            {TEAM_MEMBERS.map((member) => (
              <figure key={member.name} className="flex flex-col items-center gap-1.5">
                <div className="rounded-xl border border-border/60 bg-background/50 p-1">
                  <Image
                    src={member.imageSrc}
                    alt={member.name}
                    width={72}
                    height={72}
                    className="h-14 w-14 rounded-lg sm:h-16 sm:w-16"
                  />
                </div>
                <figcaption className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {member.role}
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
                <ExternalLink className="h-3.5 w-3.5" />
              </a>{" "}
              created Pharos and leads product direction, scoring methodology, and the data pipeline.{" "}
              <a
                href="https://x.com/Ikebillion_"
                target="_blank"
                rel="noopener noreferrer"
                className={INLINE_EXTERNAL_LINK_CLASS}
              >
                Ike
                <ExternalLink className="h-3.5 w-3.5" />
              </a>{" "}
              drives growth and communications. Most of the codebase is written and maintained by{" "}
              <a
                href="https://www.anthropic.com/claude-code"
                target="_blank"
                rel="noopener noreferrer"
                className={INLINE_EXTERNAL_LINK_CLASS}
              >
                Claude
                <ExternalLink className="h-3.5 w-3.5" />
              </a>{" "}
              and{" "}
              <a
                href="https://openai.com/codex/"
                target="_blank"
                rel="noopener noreferrer"
                className={INLINE_EXTERNAL_LINK_CLASS}
              >
                Codex
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
              , from the worker pipeline and scoring engine to the frontend and daily digest.
            </p>
          </div>
        </AboutSection>

        <AboutSection
          id="media"
          eyebrow="In the wild"
          title="Pharos in the Media"
          contentClassName="space-y-4 text-sm leading-relaxed text-muted-foreground"
        >
          {featuredAppearance ? <FeaturedAppearance appearance={featuredAppearance} /> : null}
          {otherAppearances.length > 0 ? (
            <div className="divide-y divide-border/60 border-t border-border/60">
              {otherAppearances.map((appearance) => (
                <AppearanceRow key={appearance.href} appearance={appearance} />
              ))}
            </div>
          ) : null}
        </AboutSection>

        <AboutFeatureSection
          eyebrow="Coverage"
          title="What Pharos Tracks"
          intro="The raw monitoring layer: live supply, peg behavior, blacklist activity, liquidity depth, and chain-level flow data pulled from 50+ sources into one operating picture."
          items={trackedFeatures}
        />

        <AboutFeatureSection
          eyebrow="Signals"
          title="What Pharos Computes"
          intro="The analysis layer: models and forecasts Pharos computes from its own pipeline, including a VIX for stablecoins, dependency-capped safety grades, and forward-looking depeg pressure."
          items={COMPUTED_FEATURES}
          footer={
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Telegram alerts cover DEWS state changes, depeg events, and safety grade changes.
              </p>
              <Button asChild variant="default" className={TELEGRAM_CTA_BUTTON_CLASS}>
                <Link href="/pharoswatchbot/">
                  Open @PharosWatchBot
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          }
        />

        <AboutFeatureSection
          eyebrow="Immersive data visualization"
          title="Companion Experiences"
          intro="Sibling surfaces hosted at separate origins. They consume the same Pharos data through the public API but run on their own, so they can experiment with presentation without crowding the dashboard."
          items={COMPANION_FEATURES}
        />

        <AboutSection
          eyebrow="Governance lens"
          title="Classification"
          contentClassName="text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos classifies stablecoins into three governance tiers:{" "}
            <span className="font-medium text-foreground">CeFi</span> (fully centralized),{" "}
            <span className="font-medium text-foreground">CeFi-Dependent</span> (decentralized infrastructure but
            reliant on centralized collateral or peg{" "}
            <Link href="/learn/mechanisms/" className={INLINE_EXTERNAL_LINK_CLASS}>
              mechanisms
            </Link>
            ), and <span className="font-medium text-foreground">DeFi</span> (fully on-chain, no centralized custody
            dependency). The classification reflects actual infrastructure dependency, not marketing claims.
          </p>
        </AboutSection>

        <AboutSection
          eyebrow="Source flow"
          title="Data Pipeline"
          contentClassName="space-y-5 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            All data is fetched server-side by a Cloudflare Worker and cached in D1. The browser never calls external
            APIs directly.
          </p>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,0.95fr)]">
            <div className="space-y-4 rounded-xl bg-muted/20 p-4">
              <p className="text-sm font-semibold text-foreground">Source groups</p>
              <PipelineSources />
            </div>
            <div className="space-y-4 rounded-xl bg-muted/20 p-4 lg:border-l lg:border-l-2 lg:border-border/60 lg:bg-transparent lg:p-0">
              <p className="text-sm font-semibold text-foreground">Processing path</p>
              <ol className="space-y-4">
                {DATA_PIPELINE_STEPS.map((step) => (
                  <li key={step.step} aria-label={step.ariaLabel} className="flex gap-3">
                    <div
                      aria-hidden="true"
                      className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/70 text-sm font-semibold text-foreground"
                    >
                      {step.step}
                    </div>
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-foreground">{step.title}</p>
                      <p>{step.description}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </AboutSection>

        <AboutSection
          eyebrow="Scoring details"
          title="Methodology"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos Safety Score V9 grades stablecoins across Backing Quality, Exit Strength, and Economic Control,
            then applies peg behavior, deployment adjustments, and binding caps. The methodology page covers the
            full grading formula, peg score computation, DEX liquidity scoring, and contagion stress-test design.
          </p>
          <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
            <Link href="/methodology/">
              Read the full methodology
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </AboutSection>

        <FaqSection items={faqItems} title="About Pharos FAQ" includeJsonLd />

        <aside className="border-y border-border/60 py-5 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Disclaimer:</span> Pharos is an informational tool, not a
            licensed financial advisor. Nothing on this site constitutes financial, investment, or legal advice. All
            data is provided as-is and may contain errors or delays. Always do your own research and consult a qualified
            professional before making financial decisions.
          </p>
        </aside>

        <AboutSection
          eyebrow="Reach out"
          title="Get in Touch"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos is MIT-licensed open source. If you spot a bad data point, want a stablecoin added, or want to
            understand how something is computed, open the code or reach out directly.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://github.com/TokenBrice/pharos-watch" target="_blank" rel="noopener noreferrer">
                <GitBranch className="h-4 w-4" />
                View on GitHub
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://x.com/PharosWatch" target="_blank" rel="noopener noreferrer">
                @PharosWatch
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://tokenbrice.xyz/" target="_blank" rel="noopener noreferrer">
                tokenbrice.xyz
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </AboutSection>
      </div>
    </FeaturePageShell>
  );
}
