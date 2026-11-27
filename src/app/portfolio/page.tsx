import { FeaturePageShell } from "@/components/feature-page-shell";
import { SectionErrorBoundary } from "@/components/section-error-boundary";
import { PUBLISHED_FAILURE_SCENARIO_IDS } from "@/lib/failure-scenario-index";
import { buildPageMetadata } from "@/lib/page-metadata";
import { PortfolioClient } from "./client";

const description =
  "Build your stablecoin portfolio and review your holdings' safety grades and upstream collateral exposure.";

export const metadata = buildPageMetadata({
  canonical: "/portfolio/",
  title: "Portfolio: Personal Stablecoin Risk View",
  description,
  robots: {
    index: false,
    follow: true,
  },
});

export default function PortfolioPage() {
  return (
    <FeaturePageShell
      path="/portfolio/"
      breadcrumbName="Portfolio"
      title="Portfolio"
      leadParagraphs={["Track your stablecoin holdings and assess your personal risk exposure."]}
    >
      {/* Keep the workspace in the first flush, without a dynamic Suspense reveal. */}
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <script src="/portfolio-bootstrap.js" />
      <SectionErrorBoundary name="Portfolio" supportingText="This section failed to load. Try refreshing the page.">
        <PortfolioClient scenarioCoinIds={PUBLISHED_FAILURE_SCENARIO_IDS} />
      </SectionErrorBoundary>
    </FeaturePageShell>
  );
}
