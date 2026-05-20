import type { Metadata } from "next";
import Link from "next/link";
import { CitationBlock } from "@/components/citation-block";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";

export const metadata: Metadata = buildPageMetadata({
  title: "Editorial Policy: AI-Authored Content on Pharos",
  description:
    "How Pharos writes, reviews, and labels AI-authored stablecoin summaries — model attribution, human review, corrections process, and the canonical policy anchor.",
  canonical: "/about/editorial/",
  ogImage: `${SITE_ORIGIN}/og-about.png`,
});

const INLINE_LINK_CLASS =
  "pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-frost-blue";

export default function AboutEditorialPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Editorial Policy"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "About", url: "/about/" },
        { name: "Editorial Policy", url: "/about/editorial/" },
      ]}
      path="/about/editorial/"
      title="Editorial Policy"
      variant="longform"
      leadParagraphs={[
        "Pharos uses AI to draft stablecoin summaries and editorial framing. Every coin page that carries a narrative explanation also carries a disclosure chip naming the model that wrote it and the human who reviewed it. This page is the canonical reference for how that pipeline works.",
      ]}
    >
      <section
        id="editorial-ai-policy"
        aria-labelledby="editorial-ai-policy-title"
        className="space-y-4 rounded-2xl border border-border/60 bg-card/70 px-5 py-5 text-sm leading-relaxed text-muted-foreground"
      >
        <h2 id="editorial-ai-policy-title" className="text-xl font-semibold tracking-tight text-foreground">
          AI-authored content policy
        </h2>
        <p>
          Per-coin summaries on Pharos detail pages are drafted by a large language model (currently
          Claude Opus 4.7 via the Anthropic API) against the underlying dataset Pharos already publishes:
          static profile fields, live reserve composition, depeg history, DEX-liquidity metrics, and the
          scoring outputs documented in the{" "}
          <Link href="/methodology/" className={INLINE_LINK_CLASS}>
            methodology
          </Link>
          . The model is prompted to summarize what is on the page, not to introduce facts the data does
          not support.
        </p>
        <p>
          Every summary is reviewed by the editorial maintainer (@TokenBrice) before it ships. The review
          checks for factual drift, missing context, and tone consistency with the rest of the dashboard.
          The disclosure chip on each summary records who reviewed it, when, and the &quot;facts as of&quot;
          date — the point at which the underlying figures the prose relies on were valid. If the facts
          drift, the prose is rewritten on the next editorial pass.
        </p>
        <p>
          Corrections work the same way every other data correction on Pharos does: open a{" "}
          <a
            href="https://github.com/TokenBrice/pharos-watch/issues"
            target="_blank"
            rel="noopener noreferrer"
            className={INLINE_LINK_CLASS}
          >
            GitHub issue
          </a>{" "}
          or use the feedback link on the affected coin page. Verified corrections trigger a re-draft and
          a fresh review stamp; the chip updates with the new dates.
        </p>
        <p>
          The dashboard&apos;s numeric outputs — scores, peg deviations, supply, liquidity, freezes — are
          computed by the worker pipeline, not by the model. AI only ships in the narrative panels, and
          every such panel is labelled.
        </p>
      </section>

      <CitationBlock
        entityClass="page"
        id="editorial"
        title="Pharos Editorial Policy: AI-Authored Content"
        url={`${SITE_ORIGIN}/about/editorial/`}
      />
    </FeaturePageShell>
  );
}
