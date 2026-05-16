import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import {
  PRINCIPLES_AI_POLICY,
  PRINCIPLES_AXIOMS,
  PRINCIPLES_CORRECTIONS,
  PRINCIPLES_LEAD,
} from "./content";

export const metadata: Metadata = buildPageMetadata({
  title: "Pharos Principles: Independence, Methodology, and Disclosure",
  description:
    "The ten axioms that drive what Pharos computes and what it refuses to compute, plus the AI-authoring policy and the corrections process.",
  canonical: "/about/principles/",
});

const INLINE_LINK_CLASS =
  "pharos-focus-ring rounded-sm text-foreground underline underline-offset-4 hover:text-frost-blue";

export default function AboutPrinciplesPage() {
  return (
    <FeaturePageShell
      breadcrumbName="Principles"
      breadcrumbItems={[
        { name: "Home", url: "/" },
        { name: "About", url: "/about/" },
        { name: "Principles", url: "/about/principles/" },
      ]}
      path="/about/principles/"
      title="Pharos Principles"
      variant="longform"
      leadParagraphs={[PRINCIPLES_LEAD]}
    >
      <ol className="space-y-5 text-sm leading-relaxed text-muted-foreground">
        {PRINCIPLES_AXIOMS.map((axiom, index) => (
          <li
            key={axiom.title}
            className="rounded-2xl border border-border/60 bg-card/70 px-5 py-4"
          >
            <div className="flex items-baseline gap-3">
              <span className="pharos-kicker shrink-0 tabular-nums text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h2 className="text-base font-semibold tracking-tight text-foreground">
                {axiom.title}
              </h2>
            </div>
            <p className="mt-2">{axiom.body}</p>
          </li>
        ))}
      </ol>

      <section
        aria-labelledby="principles-ai-policy-title"
        className="space-y-2 rounded-2xl border border-border/60 bg-card/70 px-5 py-4 text-sm leading-relaxed text-muted-foreground"
      >
        <h2
          id="principles-ai-policy-title"
          className="text-base font-semibold tracking-tight text-foreground"
        >
          {PRINCIPLES_AI_POLICY.title}
        </h2>
        <p>
          {PRINCIPLES_AI_POLICY.body}{" "}
          <Link href="/about/editorial/" className={INLINE_LINK_CLASS}>
            Read the full editorial policy
          </Link>
          .
        </p>
      </section>

      <section
        aria-labelledby="principles-corrections-title"
        className="space-y-2 rounded-2xl border border-border/60 bg-card/70 px-5 py-4 text-sm leading-relaxed text-muted-foreground"
      >
        <h2
          id="principles-corrections-title"
          className="text-base font-semibold tracking-tight text-foreground"
        >
          {PRINCIPLES_CORRECTIONS.title}
        </h2>
        <p>
          {PRINCIPLES_CORRECTIONS.body}{" "}
          <Link href="/funding/" className={INLINE_LINK_CLASS}>
            See the funding ledger
          </Link>{" "}
          for the inbound side of the same accountability.
        </p>
      </section>
    </FeaturePageShell>
  );
}
