import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ExternalLink, GitBranch, Radio } from "lucide-react";
import { AboutReferenceModule } from "@/components/about-reference-module";
import { Button } from "@/components/ui/button";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { buildFaqJsonLd } from "@/lib/faq";
import {
  COMPUTED_FEATURES,
  DATA_PIPELINE_STEPS,
  DATA_SOURCE_GROUPS,
  getAboutLeadParagraphs,
  getAboutFaqItems,
  getTrackedFeatures,
  TEAM_MEMBERS,
  type AboutFeatureItem,
} from "./content";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import { ACTIVE_STABLECOINS, PRE_LAUNCH_STABLECOINS } from "@shared/lib/stablecoins";

const INLINE_EXTERNAL_LINK_CLASS =
  "pharos-focus-ring inline-flex items-center gap-1 rounded-sm text-foreground underline underline-offset-4 transition-colors hover:text-frost-blue";
const CTA_BUTTON_CLASS =
  "min-h-11 w-full justify-between rounded-2xl border-border/65 bg-background/50 px-4 py-2 whitespace-normal text-left sm:h-9 sm:min-h-0 sm:w-auto sm:justify-center sm:whitespace-nowrap sm:rounded-full";

type AboutTone = "brand" | "data" | "insight" | "classification" | "neutral";

function getToneClasses(tone: AboutTone) {
  switch (tone) {
    case "brand":
      return {
        border: "border-l-frost-blue",
        kicker: "text-sky-700 dark:text-frost-blue/82",
        icon: "text-sky-700 dark:text-frost-blue/82",
        rule: "from-frost-blue/35 to-transparent",
      };
    case "data":
      return {
        border: "border-l-amber-500",
        kicker: "text-amber-700 dark:text-amber-400",
        icon: "text-amber-700 dark:text-amber-400",
        rule: "from-amber-500/35 to-transparent",
      };
    case "insight":
      return {
        border: "border-l-emerald-500",
        kicker: "text-emerald-700 dark:text-emerald-400",
        icon: "text-emerald-700 dark:text-emerald-400",
        rule: "from-emerald-500/35 to-transparent",
      };
    case "classification":
      return {
        border: "border-l-violet-500",
        kicker: "text-violet-700 dark:text-violet-400",
        icon: "text-violet-700 dark:text-violet-400",
        rule: "from-violet-500/35 to-transparent",
      };
    default:
      return {
        border: "border-l-zinc-500",
        kicker: "text-muted-foreground",
        icon: "text-muted-foreground",
        rule: "from-border to-transparent",
      };
  }
}

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

function AboutFeatureRow({ item, tone }: { item: AboutFeatureItem; tone: AboutTone }) {
  const toneClasses = getToneClasses(tone);
  const rowClassName = cn(
    "flex min-h-11 gap-3 rounded-xl px-2 py-4 sm:px-3",
    item.href && "pharos-focus-ring pharos-interactive-card group hover:bg-muted/20",
  );

  const content = (
    <>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/75">
        <item.icon className={cn("h-4 w-4", toneClasses.icon)} aria-hidden="true" />
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

function AboutSection({
  eyebrow,
  title,
  tone,
  children,
  contentClassName,
}: {
  eyebrow: string;
  title: string;
  tone: AboutTone;
  children: ReactNode;
  contentClassName?: string;
}) {
  const toneClasses = getToneClasses(tone);

  return (
    <Card className={cn("rounded-xl border-l-[3px]", toneClasses.border)}>
      <CardHeader className="space-y-2">
        <div className="flex items-center gap-3">
          <p className={cn("pharos-kicker", toneClasses.kicker)}>{eyebrow}</p>
          <div className={cn("h-px flex-1 bg-gradient-to-r", toneClasses.rule)} />
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
  tone,
  footer,
}: {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  items: readonly AboutFeatureItem[];
  tone: AboutTone;
  footer?: ReactNode;
}) {
  return (
    <AboutSection eyebrow={eyebrow} title={title} tone={tone} contentClassName="space-y-0">
      <div className="-mt-2 mb-4 max-w-3xl px-4 text-sm leading-relaxed text-muted-foreground">{intro}</div>
      <div className="divide-y divide-border/60">
        {items.map((item) => (
          <AboutFeatureRow key={item.title} item={item} tone={tone} />
        ))}
      </div>
      {footer ? <div className="mt-4 border-t border-border/60 pt-4">{footer}</div> : null}
    </AboutSection>
  );
}

export const metadata: Metadata = buildPageMetadata({
  title: "About Pharos: Shining a Light on Every Peg",
  description:
    "About Pharos, an open stablecoin analytics dashboard by TokenBrice, Ike, Claude, and Codex. Honest classification, freeze tracking, and a graveyard for the ones that didn't make it.",
  canonical: "/about/",
});

export default function AboutPage() {
  const activeStablecoinCount = ACTIVE_STABLECOINS.length;
  const preLaunchStablecoinCount = PRE_LAUNCH_STABLECOINS.length;
  const deadStablecoinCount = DEAD_STABLECOINS.length;
  const trackedFeatures = getTrackedFeatures({
    activeStablecoins: activeStablecoinCount,
    deadStablecoins: deadStablecoinCount,
    preLaunchStablecoins: preLaunchStablecoinCount,
  });
  const faqItems = getAboutFaqItems({
    activeStablecoins: activeStablecoinCount,
    deadStablecoins: deadStablecoinCount,
  });
  const leadParagraphs = getAboutLeadParagraphs({ activeStablecoins: activeStablecoinCount });

  return (
    <FeaturePageShell
      breadcrumbName="About Pharos"
      path="/about/"
      title="About Pharos"
      leadParagraphs={leadParagraphs}
      headerSupplement={<AboutReferenceModule />}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd(buildFaqJsonLd(faqItems)),
          }}
        />
      }
    >
      <div className="space-y-8">
        <AboutSection
          eyebrow="Why it exists"
          title="Why Pharos?"
          tone="brand"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Stablecoins are the backbone of on-chain finance, yet the data to evaluate them is scattered, inconsistent,
            or buried behind paywalls. Worse, marketing claims rarely match reality: a &quot;decentralized&quot; stablecoin may rely
            entirely on centralized collateral. An issuer can freeze balances without warning. A deep liquidity pool on one
            DEX can evaporate overnight. And when a major stablecoin fails, the collateral chains transmit that stress to
            dozens of derivatives that looked safe in isolation.
          </p>
          <p>
            Pharos was built to make these risks visible. It tracks {ACTIVE_STABLECOINS.length} live stablecoins,{" "}
            {PRE_LAUNCH_STABLECOINS.length} upcoming launches, and {DEAD_STABLECOINS.length} dead ones, then scores the
            live universe with honest governance classification, transitive dependency scoring, and live reserve
            composition where available. Real-time depeg detection, freeze monitoring across 35 stablecoins, safety
            grades that cap scores based on upstream exposure, and a 30-minute ecosystem-wide stability index give you
            the full picture before a crisis makes the headlines.
          </p>
          <p>
            Pharos is a public good. The dashboard stays free, the code is open source, and sustainability comes
            from community support plus future paid API access for heavy programmatic usage.{" "}
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
            For architecture, methodology, and design references, use the{" "}
            <Link href="/docs/" className={INLINE_EXTERNAL_LINK_CLASS}>
              documentation archive
            </Link>
            .
          </p>
        </AboutSection>

        <AboutSection
          eyebrow="The team"
          title="Who Is Building Pharos?"
          tone="brand"
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
              drives growth and communications, getting Pharos in front of the people who need it. The engineering is
              AI-native: most of the codebase is written and maintained by{" "}
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
          eyebrow="In the wild"
          title="Live Walkthrough"
          tone="brand"
          contentClassName="flex flex-col gap-4 text-sm leading-relaxed text-muted-foreground sm:flex-row sm:items-start"
        >
          <Radio className={cn("mt-0.5 h-5 w-5 shrink-0", getToneClasses("brand").icon)} />
          <div className="space-y-3">
            <p>
              TokenBrice walked through Pharos live on Leviathan News, covering the motivation behind the project, how
              the data pipeline works, and how the main risk signals should be read in practice.
            </p>
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://x.com/i/broadcasts/1qxvvkeMlyAxB" target="_blank" rel="noopener noreferrer">
                Watch the Leviathan News broadcast
                <ExternalLink className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </AboutSection>

        <AboutFeatureSection
          eyebrow="Coverage"
          title="What Pharos Tracks"
          intro="The raw monitoring layer — live supply, peg behavior, blacklist activity, liquidity depth, and chain-level flow data pulled from 50+ sources into one operating picture."
          items={trackedFeatures}
          tone="data"
        />

        <AboutFeatureSection
          eyebrow="Signals"
          title="What Pharos Computes"
          intro="The analysis layer — models, scores, and forecasts you cannot find anywhere else: a VIX for stablecoins, dependency-capped safety grades, and forward-looking depeg pressure."
          items={COMPUTED_FEATURES}
          tone="insight"
          footer={
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
                Telegram alerts cover DEWS state changes, depeg events, and safety grade changes.
              </p>
              <Button asChild variant="default" className={CTA_BUTTON_CLASS}>
                <Link href="/telegram/">
                  Open @PharosWatchBot
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          }
        />

        <AboutSection
          eyebrow="Governance lens"
          title="Classification"
          tone="classification"
          contentClassName="text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos classifies stablecoins into three governance tiers:{" "}
            <span className="font-medium text-foreground">CeFi</span> (fully centralized),{" "}
            <span className="font-medium text-foreground">CeFi-Dependent</span> (decentralized infrastructure but
            reliant on centralized collateral or peg mechanisms), and{" "}
            <span className="font-medium text-foreground">DeFi</span> (fully on-chain, no centralized custody
            dependency). The classification reflects actual infrastructure dependency, not marketing claims.
          </p>
        </AboutSection>

        <AboutSection
          eyebrow="Source flow"
          title="Data Pipeline"
          tone="data"
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
          tone="data"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos grades every stablecoin across four weighted base dimensions, with peg stability acting as a
            multiplier on top. The methodology page covers the full grading formula, peg score computation, DEX liquidity scoring, and
            contagion stress-test design.
          </p>
          <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
            <Link href="/methodology/">
              Read the full methodology
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        </AboutSection>

        <aside className="border-y border-border/60 py-5 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">Disclaimer</span> — Pharos is an informational tool, not a
            licensed financial advisor. Nothing on this site constitutes financial, investment, or legal advice. All
            data is provided as-is and may contain errors or delays. Always do your own research and consult a qualified
            professional before making financial decisions.
          </p>
        </aside>

        <AboutSection
          eyebrow="Reach out"
          title="Get in Touch"
          tone="brand"
          contentClassName="space-y-3 text-sm leading-relaxed text-muted-foreground"
        >
          <p>
            Pharos is MIT-licensed open source. If you spot a bad data point, want a stablecoin added, or want to
            understand how something is computed, open the code or reach out directly.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" className={CTA_BUTTON_CLASS}>
              <a href="https://github.com/TokenBrice/stablecoin-dashboard" target="_blank" rel="noopener noreferrer">
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
