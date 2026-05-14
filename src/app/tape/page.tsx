import type { Metadata } from "next";
import { FeaturePageShell } from "@/components/feature-page-shell";
import { safeJsonLd } from "@/lib/json-ld";
import { buildPageMetadata } from "@/lib/page-metadata";
import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { TapeClient } from "./client";

const TAPE_DESCRIPTION =
  "The unified time axis of Pharos: every confirmed depeg, freeze, and safety-grade change across tracked stablecoins on one feed.";

export const metadata: Metadata = buildPageMetadata({
  title: "The Tape: Stablecoin Market Event Feed",
  description: TAPE_DESCRIPTION,
  canonical: "/tape/",
});

export default function TapePage() {
  return (
    <FeaturePageShell
      breadcrumbName="The Tape"
      path="/tape/"
      title="The Tape"
      statusBadge={{ status: "beta" }}
      preface={(
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLd({
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              "@id": `${SITE_URL}/tape/#collection`,
              name: "The Tape — Stablecoin Market Event Feed",
              description: TAPE_DESCRIPTION,
              url: `${SITE_URL}/tape/`,
              isPartOf: { "@id": `${SITE_URL}#website` },
            }),
          }}
        />
      )}
      leadParagraphs={[
        "A unified chronological feed of confirmed depegs, address freezes, and safety-grade changes across the stablecoins Pharos tracks.",
      ]}
    >
      <TapeClient />
    </FeaturePageShell>
  );
}
