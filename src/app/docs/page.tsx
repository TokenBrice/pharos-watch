import type { Metadata } from "next";
import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { DOC_GROUPS, PUBLIC_DOCS } from "@shared/lib/public-docs";

export const metadata: Metadata = buildPageMetadata({
  title: "Docs - Pharos Documentation Archive",
  description:
    "Architectural, methodology, and design documentation for the Pharos stablecoin analytics platform.",
  canonical: "/docs/",
});

const GROUP_TITLES: Record<(typeof DOC_GROUPS)[number], string> = {
  system: "System and Data",
  methodology: "Methodology",
  design: "Design",
};

export default function DocsIndexPage() {
  const byGroup: Record<(typeof DOC_GROUPS)[number], typeof PUBLIC_DOCS> = {
    system: PUBLIC_DOCS.filter((doc) => doc.group === "system"),
    methodology: PUBLIC_DOCS.filter((doc) => doc.group === "methodology"),
    design: PUBLIC_DOCS.filter((doc) => doc.group === "design"),
  };

  return (
    <FeaturePageShell
      breadcrumbName="Docs"
      path="/docs/"
      title="Documentation"
      variant="longform"
      containerClassName="mx-auto max-w-3xl"
      leadParagraphs={[
        "Architecture, methodology, and design references for Pharos. Human-readable pages are paired with markdown negotiation for agent consumption.",
      ]}
    >
      <div className="space-y-10">
        {DOC_GROUPS.map((group) => (
          <section key={group} className="space-y-4">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">{GROUP_TITLES[group]}</h2>
            <ul className="space-y-3">
              {byGroup[group].map((doc) => (
                <li key={doc.slug} className="border-b border-border/50 pb-3 last:border-b-0">
                  <Link
                    href={`/docs/${doc.slug}/`}
                    className="pharos-focus-ring rounded-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground"
                  >
                    {doc.title}
                  </Link>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{doc.summary}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </FeaturePageShell>
  );
}
