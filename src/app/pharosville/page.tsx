import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { buildPageMetadata } from "@/lib/page-metadata";
import { PharosVilleClient } from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "PharosVille",
  description:
    "A beta desktop RPG island-city prototype for exploring Pharos stablecoin market signals.",
  canonical: "/pharosville/",
  robots: {
    index: false,
    follow: true,
  },
});

export default function PharosVillePage() {
  return (
    <div data-pharosville-route>
      <BreadcrumbJsonLd items={[{ name: "Home", url: "/" }, { name: "PharosVille", url: "/pharosville/" }]} />
      <h1 id="pharosville-heading" className="sr-only">PharosVille</h1>
      <SectionErrorBoundary name="PharosVille" supportingText="Refresh the page to retry the PharosVille map.">
        <PharosVilleClient />
      </SectionErrorBoundary>
    </div>
  );
}
