import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import type { BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { safeJsonLd } from "@/lib/json-ld";
import type { InfrastructureTaxonomyValue, StablecoinTaxonomyPage } from "@/lib/stablecoin-taxonomy";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import type { BackingType, GovernanceType } from "@shared/types";

interface StablecoinTaxonomyHubProps {
  breadcrumbName: string;
  path: string;
  breadcrumbItems: BreadcrumbItem[];
  title: string;
  leadParagraphs: string[];
  itemListName: string;
  pages: ReadonlyArray<StablecoinTaxonomyPage<BackingType | GovernanceType | InfrastructureTaxonomyValue>>;
}

export function StablecoinTaxonomyHub({
  breadcrumbName,
  path,
  breadcrumbItems,
  title,
  leadParagraphs,
  itemListName,
  pages,
}: StablecoinTaxonomyHubProps) {
  return (
    <FeaturePageShell
      breadcrumbName={breadcrumbName}
      path={path}
      breadcrumbItems={breadcrumbItems}
      title={title}
      leadParagraphs={leadParagraphs}
      preface={
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd([
              {
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                name: title,
                url: `${SITE_URL}${path}`,
                isPartOf: { "@id": `${SITE_URL}#website` },
              },
              {
                "@context": "https://schema.org",
                "@type": "ItemList",
                name: itemListName,
                numberOfItems: pages.length,
                itemListElement: pages.map((page, index) => ({
                  "@type": "ListItem",
                  position: index + 1,
                  name: page.title,
                  url: `${SITE_URL}${page.href}`,
                })),
              },
            ]),
          }}
        />
      }
    >
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pages.map((page) => (
          <Link
            key={page.href}
            href={page.href}
            className="pharos-focus-ring rounded-2xl border border-border/60 bg-card/60 px-4 py-4 transition-colors hover:bg-accent"
          >
            <span className="block text-base font-semibold tracking-tight text-foreground">{page.title}</span>
            <span className="mt-2 block text-sm text-muted-foreground">{page.description}</span>
            <span className="mt-3 block text-xs font-medium text-muted-foreground">{page.coins.length} active</span>
          </Link>
        ))}
      </section>
    </FeaturePageShell>
  );
}
