import type { Metadata } from "next";
import { BreadcrumbJsonLd } from "@/components/breadcrumb-json-ld";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { buildPageMetadata } from "@/lib/page-metadata";
import { LighthouseClient } from "./client";

export const metadata: Metadata = buildPageMetadata({
  title: "PharosVille",
  description:
    "A beta desktop RPG island-city prototype for exploring Pharos stablecoin market signals.",
  canonical: "/lighthouse/",
  robots: {
    index: false,
    follow: true,
  },
});

export default function LighthousePage() {
  return (
    <div className="relative left-1/2 w-[100vw] -translate-x-1/2 md:w-[calc(100vw-var(--sidebar-width-expanded))]">
      <BreadcrumbJsonLd items={[{ name: "Home", url: "/" }, { name: "PharosVille", url: "/lighthouse/" }]} />
      <h1 id="lighthouse-heading" className="sr-only">PharosVille</h1>
      <SectionErrorBoundary name="PharosVille" supportingText="Refresh the page to retry the PharosVille map.">
        <LighthouseClient />
      </SectionErrorBoundary>
    </div>
  );
}
