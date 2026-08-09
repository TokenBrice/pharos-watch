import Link from "next/link";
import { FeaturePageShell } from "@/components/feature-page-shell";
import type { BreadcrumbItem } from "@/components/breadcrumb-json-ld";
import { buildCollectionItemListJsonLd, safeJsonLd } from "@/lib/json-ld";
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
            __html: safeJsonLd(
              buildCollectionItemListJsonLd({
                url: `${SITE_URL}${path}`,
                name: title,
                itemListName,
                entries: pages.map((page) => ({
                  name: page.title,
                  url: `${SITE_URL}${page.href}`,
                })),
              }),
            ),
          }}
        />
      }
    >
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {pages.map((page) => (
          <Link
            key={page.href}
            href={page.href}
            className="pharos-focus-ring pharos-card-shell pharos-interactive-card px-4 py-4"
          >
            <span className="block text-lg font-semibold tracking-tight text-foreground">{page.title}</span>
            <span className="mt-2 block text-sm text-muted-foreground">{page.description}</span>
            <span className="mt-3 block text-xs font-medium text-muted-foreground">
              <span className="pharos-numeric">{page.coins.length}</span> active
            </span>
          </Link>
        ))}
      </section>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Source: checked-in StablecoinMeta profile fields in the current Pharos build. Active counts are static taxonomy
        context and should be paired with the linked live directories for current market coverage.
      </p>
    </FeaturePageShell>
  );
}
