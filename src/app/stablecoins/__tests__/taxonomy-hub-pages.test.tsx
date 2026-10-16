import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as backingRoute from "../backing/[backing]/page";
import * as governanceRoute from "../governance/[governance]/page";
import * as infrastructureRoute from "../infrastructure/[infrastructure]/page";
import {
  BACKING_TAXONOMY_PAGES,
  GOVERNANCE_TAXONOMY_PAGES,
  INFRASTRUCTURE_TAXONOMY_PAGES,
} from "@/lib/stablecoin-taxonomy";

vi.mock("@/components/stablecoin-filtered-table", () => ({ StablecoinFilteredTable: () => <div /> }));

describe("stablecoin taxonomy hub pages", () => {
  it.each([
    ["backing", "Backing Type Not Found", BACKING_TAXONOMY_PAGES, backingRoute.generateStaticParams, (slug: string) => backingRoute.generateMetadata({ params: Promise.resolve({ backing: slug }) }), (slug: string) => backingRoute.default({ params: Promise.resolve({ backing: slug }) })],
    ["governance", "Governance Type Not Found", GOVERNANCE_TAXONOMY_PAGES, governanceRoute.generateStaticParams, (slug: string) => governanceRoute.generateMetadata({ params: Promise.resolve({ governance: slug }) }), (slug: string) => governanceRoute.default({ params: Promise.resolve({ governance: slug }) })],
    ["infrastructure", "Infrastructure Cohort Not Found", INFRASTRUCTURE_TAXONOMY_PAGES, infrastructureRoute.generateStaticParams, (slug: string) => infrastructureRoute.generateMetadata({ params: Promise.resolve({ infrastructure: slug }) }), (slug: string) => infrastructureRoute.default({ params: Promise.resolve({ infrastructure: slug }) })],
  ] as const)("preserves the %s detail route contract", async (paramKey, missingTitle, pages, staticParams, metadata, Page) => {
    const page = pages[0];

    expect(staticParams()).toEqual(pages.map((entry) => ({ [paramKey]: entry.slug })));
    await expect(metadata(page.slug)).resolves.toMatchObject({
      title: page.title,
      alternates: { canonical: page.href },
      openGraph: { images: [{ url: expect.stringContaining("/og-stablecoins.png") }] },
    });
    await expect(metadata("missing")).resolves.toEqual({
      title: missingTitle,
    });
    expect(renderToStaticMarkup(await Page(page.slug))).toContain(page.title);
  });

});
