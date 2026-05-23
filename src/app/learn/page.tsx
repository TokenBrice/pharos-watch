import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight, BookA, Lightbulb, ScrollText, type LucideIcon } from "lucide-react";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/core";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { GLOSSARY_ENTRIES } from "./glossary/content";
import { CASE_STUDY_LIST } from "./case-studies/content";

export const metadata: Metadata = buildPageMetadata({
  title: "Learn — Pharos",
  description:
    "The Pharos learning center: how each stablecoin design holds its peg, long-form depeg case studies, and a version-pinned glossary.",
  canonical: "/learn/",
  ogImage: `${SITE_ORIGIN}/og-editorial-learn.png`,
});

interface LearnSection {
  href: string;
  icon: LucideIcon;
  title: string;
  description: string;
  count: string;
}

const SECTIONS: LearnSection[] = [
  {
    href: "/learn/mechanisms/",
    icon: Lightbulb,
    title: "Mechanisms",
    description:
      "Six plain-English explainers covering every stablecoin design Pharos tracks — what produces the peg, and where each one tends to break.",
    count: `${MECHANISM_ARCHETYPE_VALUES.length} archetypes`,
  },
  {
    href: "/learn/case-studies/",
    icon: ScrollText,
    title: "Case Studies",
    description:
      "Long-form retrospectives of the depegs and failures that reshaped the market — Terra, USDC/SVB, DAI, and more — sourced from Pharos data.",
    count: `${CASE_STUDY_LIST.length} studies`,
  },
  {
    href: "/learn/glossary/",
    icon: BookA,
    title: "Glossary",
    description:
      "The Pharos vocabulary, alphabetized and version-pinned: PSI, DEWS, PegScore, LiquidityScore, FreezeWatch, and the bands each one refers to.",
    count: `${GLOSSARY_ENTRIES.length} terms`,
  },
];

const REFERENCES: { href: string; label: string }[] = [
  { href: "/methodology/", label: "Methodology — formulas, thresholds, and changelogs" },
  { href: "/depeg/", label: "Depeg — the live incident board" },
  { href: "/cemetery/", label: "Cemetery — failed stablecoins and their post-mortems" },
  { href: "/timeline/", label: "Timeline — the unified chronological event feed" },
];

export default function LearnHub() {
  return (
    <FeaturePageShell
      breadcrumbName="Learn"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "Learn", url: "/learn/" },
      ]}
      path="/learn/"
      title="Learn"
      leadParagraphs={[
        "Everything Pharos knows about how stablecoins hold — and lose — their peg, written to be read. Start with the mechanism explainers, study the failures that defined the market, or look up a term.",
      ]}
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((section) => {
          const Icon = section.icon;
          return (
            <Link
              key={section.href}
              href={section.href}
              className="pharos-focus-ring group flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-5 transition-colors hover:border-frost-blue/60 sm:p-6"
            >
              <div className="flex items-center justify-between">
                <Icon
                  className="h-6 w-6 text-frost-blue"
                  aria-hidden="true"
                />
                <ArrowUpRight
                  className="h-4 w-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue"
                  aria-hidden="true"
                />
              </div>
              <h2 className="text-lg font-bold tracking-tight text-foreground transition-colors group-hover:text-frost-blue">
                {section.title}
              </h2>
              <p className="text-[14px] leading-relaxed text-muted-foreground">
                {section.description}
              </p>
              <p className="mt-auto pt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                {section.count}
              </p>
            </Link>
          );
        })}
      </div>

      <section className="space-y-4 border-t border-border/60 pt-8">
        <p className="pharos-kicker text-muted-foreground">Related references</p>
        <ul className="grid gap-3 sm:grid-cols-2">
          {REFERENCES.map((ref) => (
            <li key={ref.href}>
              <Link
                href={ref.href}
                className="pharos-focus-ring group flex items-start justify-between gap-3 border-b border-border/40 py-3 text-[15px] leading-snug text-foreground transition-colors hover:border-frost-blue/60 hover:text-frost-blue"
              >
                <span>{ref.label}</span>
                <ArrowUpRight
                  className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-frost-blue"
                  aria-hidden="true"
                />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </FeaturePageShell>
  );
}
