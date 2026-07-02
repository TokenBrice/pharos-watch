import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
import { BluechipActiveList } from "./active-list";
import {
  BLUECHIP_GATES,
  BLUECHIP_LEDE,
  BLUECHIP_REFUSALS,
  BLUECHIP_WHAT_IT_MEANS,
} from "./content";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Bluechip Stablecoins: Safety Criteria & List",
  description:
    "See which stablecoins qualify for Pharos Bluechip status and the safety, liquidity, resilience, peg, and dependency-risk gates behind the designation.",
  canonical: "/about/bluechip/",
  ogImage: `${SITE_ORIGIN}/og-editorial-about.png`,
});

function BluechipSection({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  const slug = eyebrow.replace(/\s+/g, "-").toLowerCase();
  const headingId = `bluechip-${slug}`;

  return (
    <section aria-labelledby={headingId} className="space-y-5">
      <header className="space-y-2">
        <p className="pharos-kicker">{eyebrow}</p>
        <h2
          id={headingId}
          className="pharos-display text-2xl font-bold leading-tight tracking-tight text-foreground"
        >
          {title}
        </h2>
        <div className="h-px bg-border/60" aria-hidden="true" />
      </header>
      {children}
    </section>
  );
}

export default function AboutBluechipPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Bluechip"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "About", url: "/about/" },
        { name: "Bluechip", url: "/about/bluechip/" },
      ]}
      path="/about/bluechip/"
      title="Pharos Bluechip"
      variant="longform"
      leadParagraphs={[BLUECHIP_LEDE]}
      headerSupplement={
        <p className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          Methodology {SAFETY_SCORE_METHODOLOGY_VERSION_LABEL} ·{" "}
          <Link
            href="/methodology/#safety-scores-methodology"
            className="pharos-prose-link"
          >
            Read the rules
          </Link>
        </p>
      }
    >
      <div className="space-y-12">
        <BluechipSection eyebrow="Section 1" title="What Bluechip means">
          {BLUECHIP_WHAT_IT_MEANS.map((paragraph, index) => (
            <p
              key={index}
              className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]"
            >
              {paragraph}
            </p>
          ))}
        </BluechipSection>

        <BluechipSection eyebrow="Section 2" title="The gates">
          <p className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]">
            Each gate is independent. A coin clears Bluechip only when every gate clears at the same
            moment, and only while it continues to do so.
          </p>
          <ol className="divide-y divide-border/60 border-y border-border/60">
            {BLUECHIP_GATES.map((gate, index) => (
              <li
                key={gate.id}
                className="grid gap-1 py-4 sm:grid-cols-[3.5rem_minmax(0,1fr)] sm:gap-6"
              >
                <span className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
                  Gate {String(index + 1).padStart(2, "0")}
                </span>
                <div className="space-y-1">
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    {gate.title}
                  </h3>
                  <p className="text-sm leading-relaxed text-foreground/82 sm:text-[0.95rem]">
                    {gate.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </BluechipSection>

        <BluechipSection eyebrow="Section 3" title="What Bluechip refuses to grant">
          <p className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]">
            These are the calls Pharos refuses to make under the Bluechip label, regardless of how the
            other dimensions read. The refusals are part of the rating — they are not gaps waiting to
            be filled.
          </p>
          <div className="space-y-6">
            {BLUECHIP_REFUSALS.map((entry) => (
              <article key={entry.title} className="space-y-2">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  <span className="font-mono uppercase tracking-[0.06em] text-muted-foreground">
                    Refuses —
                  </span>{" "}
                  {entry.title}
                </h3>
                <p className="text-sm leading-relaxed text-foreground/82 sm:text-[0.95rem]">
                  {entry.body}
                </p>
              </article>
            ))}
          </div>
        </BluechipSection>

        <BluechipSection eyebrow="Section 4" title="Methodology and audit trail">
          <p className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]">
            Bluechip rides the Safety Score methodology version. When a floor definition changes, the
            version pin moves with it; the editorial designation is re-derived against the new rules
            before the next refresh, never grandfathered.
          </p>
          <dl className="divide-y divide-border/60 border-y border-border/60">
            <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-sm font-semibold tracking-tight text-foreground">
                Current version
              </dt>
              <dd className="font-mono text-sm tracking-tight text-foreground/85">
                Methodology {SAFETY_SCORE_METHODOLOGY_VERSION_LABEL}
              </dd>
            </div>
            <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-sm font-semibold tracking-tight text-foreground">
                Rules of record
              </dt>
              <dd className="text-sm leading-relaxed text-foreground/82 sm:text-[0.95rem]">
                <Link
                  href="/methodology/#safety-scores-methodology"
                  className="pharos-prose-link"
                >
                  Safety Scores methodology →
                </Link>
              </dd>
            </div>
            <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-sm font-semibold tracking-tight text-foreground">
                Version history
              </dt>
              <dd className="text-sm leading-relaxed text-foreground/82 sm:text-[0.95rem]">
                <Link
                  href="/methodology/scoring-changelog/"
                  className="pharos-prose-link"
                >
                  Scoring changelog →
                </Link>
              </dd>
            </div>
            <div className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6">
              <dt className="text-sm font-semibold tracking-tight text-foreground">
                Cross-reference
              </dt>
              <dd className="text-sm leading-relaxed text-foreground/82 sm:text-[0.95rem]">
                <Link
                  href="/learn/glossary/#bluechip"
                  className="pharos-prose-link"
                >
                  Glossary entry →
                </Link>
              </dd>
            </div>
          </dl>
        </BluechipSection>

        <BluechipSection eyebrow="Section 5" title="Active Bluechip stablecoins">
          <p className="text-sm leading-relaxed text-foreground/88 sm:text-[0.95rem]">
            The coins below are the live intersection of external Bluechip A-tier ratings and
            Pharos A-tier report cards. The roster is current-state, not historical: a coin that
            falls below either floor leaves the list in the next refresh.
          </p>
          <BluechipActiveList />
        </BluechipSection>

        <aside className="border-t border-border/60 pt-5 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">A note on naming</span> — Pharos
            Bluechip is an editorial designation Pharos issues against published methodology, not a
            substitute for the underlying Bluechip rating sync that informs it. The per-coin badge
            still links to the external Bluechip report; this page is the Pharos framing of why the
            label is rendered with editorial weight.
          </p>
        </aside>
      </div>
    </FeaturePageShell>
  );
}
