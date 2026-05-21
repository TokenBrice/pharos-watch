import type { Metadata } from "next";
import type { ReactNode } from "react";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { digestDisplay } from "@/lib/fonts/digest";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import {
  STYLE_ANTI_TERMS,
  STYLE_DEWS_BANDS,
  STYLE_GRADE_ALPHABET,
  STYLE_LEAD,
  STYLE_NUMBER_RULES,
  STYLE_PROPER_NOUNS,
  STYLE_TONE,
  STYLE_TONE_NOTE,
} from "./content";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Style Guide — Pharos",
  description:
    "How Pharos writes about stablecoins: proper nouns, anti-terms, number conventions, and the tone Pharos refuses to drift away from.",
  canonical: "/about/style/",
  ogImage: `${SITE_ORIGIN}/og-editorial-about.png`,
});

function StyleSection({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={`style-${eyebrow.replace(/\s+/g, "-").toLowerCase()}`} className="space-y-5">
      <header className="space-y-2">
        <p className="pharos-kicker">{eyebrow}</p>
        <h2
          id={`style-${eyebrow.replace(/\s+/g, "-").toLowerCase()}`}
          className={`${digestDisplay.className} text-[1.55rem] font-semibold leading-tight tracking-[-0.01em] text-foreground sm:text-[1.7rem]`}
        >
          {title}
        </h2>
        <div className="h-px bg-border/60" aria-hidden="true" />
      </header>
      {children}
    </section>
  );
}

export default function AboutStylePage() {
  return (
    <FeaturePageShell
      breadcrumbName="Style Guide"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "About", url: "/about/" },
        { name: "Style Guide", url: "/about/style/" },
      ]}
      path="/about/style/"
      title="Pharos Style Guide"
      variant="longform"
      leadParagraphs={[STYLE_LEAD]}
    >
      <div className="space-y-12">
        <StyleSection eyebrow="Section 1" title="Proper nouns">
          <p className={`${digestDisplay.className} text-[1.05rem] leading-relaxed text-foreground/90`}>
            Pharos has a vocabulary. Each of the terms below is a Title-Case proper noun and is rendered
            that way wherever it appears in product copy, OG cards, methodology, or briefings.
          </p>
          <dl className="divide-y divide-border/60 border-y border-border/60">
            {STYLE_PROPER_NOUNS.map((entry) => (
              <div
                key={entry.term}
                className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6"
              >
                <dt className="text-sm font-semibold tracking-tight text-foreground">{entry.term}</dt>
                <dd className={`${digestDisplay.className} text-[1.02rem] leading-relaxed text-foreground/85`}>
                  {entry.body}
                </dd>
              </div>
            ))}
          </dl>
          <div className="grid gap-5 rounded-2xl border border-border/60 bg-card/60 px-5 py-5 sm:grid-cols-2">
            <div className="space-y-2">
              <p className="pharos-kicker">DEWS bands</p>
              <ol className="flex flex-wrap gap-2 font-mono text-xs uppercase tracking-[0.08em] text-foreground/85">
                {STYLE_DEWS_BANDS.map((band) => (
                  <li
                    key={band}
                    className="rounded-md border border-border/60 bg-background/60 px-2 py-1"
                  >
                    {band}
                  </li>
                ))}
              </ol>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Always rendered as Title-Case proper nouns. Lowercased only when the word is doing its
                ordinary work (&quot;a calmer week&quot;) — never when naming the band.
              </p>
            </div>
            <div className="space-y-2">
              <p className="pharos-kicker">Grade alphabet</p>
              <ol className="flex flex-wrap gap-2 font-mono text-xs tabular-nums uppercase tracking-[0.06em] text-foreground/85">
                {STYLE_GRADE_ALPHABET.map((grade) => (
                  <li
                    key={grade}
                    className="rounded-md border border-border/60 bg-background/60 px-2 py-1"
                  >
                    {grade}
                  </li>
                ))}
              </ol>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Eleven grades, no half-steps outside this list. A coin is graded A-, never A−− or A-minus-minus.
              </p>
            </div>
          </div>
        </StyleSection>

        <StyleSection eyebrow="Section 2" title="What we don't say">
          <p className={`${digestDisplay.className} text-[1.05rem] leading-relaxed text-foreground/90`}>
            The phrases below are rejected in product copy. They are not banned because they are taboo;
            they are rejected because they obscure something Pharos exists to make visible.
          </p>
          <div className="space-y-6">
            {STYLE_ANTI_TERMS.map((entry) => (
              <article key={entry.term} className="space-y-2">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">
                  <span className="font-mono uppercase tracking-[0.06em] text-muted-foreground">
                    Don&apos;t say —
                  </span>{" "}
                  &ldquo;{entry.term}&rdquo;
                </h3>
                <p className={`${digestDisplay.className} text-[1.02rem] leading-relaxed text-foreground/85`}>
                  {entry.body}
                </p>
              </article>
            ))}
          </div>
        </StyleSection>

        <StyleSection eyebrow="Section 3" title="Numbers">
          <p className={`${digestDisplay.className} text-[1.05rem] leading-relaxed text-foreground/90`}>
            Numbers in Pharos are the load-bearing part of the page. They are typeset and scaled by rule, not
            by feel.
          </p>
          <dl className="divide-y divide-border/60 border-y border-border/60">
            {STYLE_NUMBER_RULES.map((entry) => (
              <div
                key={entry.topic}
                className="grid gap-1 py-4 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6"
              >
                <dt className="text-sm font-semibold tracking-tight text-foreground">{entry.topic}</dt>
                <dd className={`${digestDisplay.className} text-[1.02rem] leading-relaxed text-foreground/85`}>
                  {entry.body}
                </dd>
              </div>
            ))}
          </dl>
        </StyleSection>

        <StyleSection eyebrow="Section 4" title="Tone">
          <p className={`${digestDisplay.className} text-[1.05rem] leading-relaxed text-foreground/90`}>
            Four oppositions. When a line could read either way, the right side loses.
          </p>
          <ol className="grid gap-3 sm:grid-cols-2">
            {STYLE_TONE.map((axiom) => (
              <li
                key={axiom.prefer}
                className="flex items-baseline justify-between gap-4 rounded-xl border border-border/60 bg-card/60 px-4 py-3"
              >
                <span className="text-base font-semibold tracking-tight text-foreground">
                  {axiom.prefer}
                </span>
                <span className="font-mono text-xs uppercase tracking-[0.08em] text-muted-foreground">
                  not {axiom.reject.toLowerCase()}
                </span>
              </li>
            ))}
          </ol>
          <p className={`${digestDisplay.className} text-[1.02rem] leading-relaxed text-foreground/85`}>
            {STYLE_TONE_NOTE}
          </p>
        </StyleSection>

        <aside className="border-t border-border/60 pt-5 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-semibold text-foreground">A note on enforcement</span> — this guide is
            descriptive of how Pharos already writes, but it is also the page the project can be cited
            against when the dashboard drifts. Drift happens; the page is the correction surface.
          </p>
        </aside>
      </div>
    </FeaturePageShell>
  );
}
