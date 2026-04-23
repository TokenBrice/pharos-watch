import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { CemeteryClient } from "@/components/cemetery-client";
import { CemeteryCharts } from "@/components/cemetery-charts";
import { FaqSection } from "@/components/faq-section";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import type { FaqItem } from "@/lib/faq";
import { sortCemeteryCoins } from "@/lib/cemetery";

const cemeteryDescription = `A memorial to ${DEAD_STABLECOINS.length} fallen stablecoins. From TerraUSD to HUSD: what went wrong, when, and why.`;

export const metadata: Metadata = buildPageMetadata({
  title: "Stablecoin Cemetery: Failed & Defunct Stablecoins",
  description: cemeteryDescription,
  canonical: "/cemetery/",
  ogImage: `${SITE_URL}/og-cemetery.png`,
});

const FAQ_ITEMS = [
  {
    question: "What causes stablecoins to fail?",
    answer:
      "Stablecoins fail for several recurring reasons: algorithmic designs that rely on reflexive token mechanics (like TerraUSD), custodial failures where the issuer loses or mismanages reserves, liquidity drains where redemptions outpace available collateral, regulatory shutdowns that freeze operations, and simple abandonment when the team stops maintaining the peg. Most failures share a common pattern: loss of market confidence triggers a bank-run dynamic that the stabilization mechanism cannot absorb.",
  },
] as const satisfies readonly FaqItem[];

export default function CemeteryPage() {
  const schemaCoins = sortCemeteryCoins(DEAD_STABLECOINS, "newest");

  return (
    <div className="space-y-6">
      <BreadcrumbJsonLd
        items={[
          { name: "Home", url: "/" },
          { name: "Stablecoin Cemetery", url: "/cemetery/" },
        ]}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLd([
            {
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              "@id": `${SITE_URL}/cemetery/#collection`,
              name: "Stablecoin Cemetery",
              description: cemeteryDescription,
              url: `${SITE_URL}/cemetery/`,
              image: `${SITE_URL}/og-cemetery.png`,
              mainEntity: {
                "@type": "ItemList",
                itemListElement: schemaCoins.map((coin, index) => ({
                  "@type": "ListItem",
                  position: index + 1,
                  name: coin.name,
                  url: `${SITE_URL}/stablecoin/${coin.id}/`,
                })),
              },
            },
          ]),
        }}
      />
      <CemeteryCharts />
      <CemeteryClient />
      <FaqSection items={FAQ_ITEMS} />
    </div>
  );
}
