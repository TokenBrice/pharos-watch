import { FeaturePageShell } from "@/components/feature-page-shell";
import { buildPageMetadata } from "@/lib/page-metadata";
import { ApiReferencePanel } from "../api-reference-panel";
import { ApiTabs } from "../api-tabs";

export const metadata = buildPageMetadata({
  title: "Stablecoin API Reference: Endpoints & Responses",
  description: "Public Pharos API authentication, endpoints, response contracts, datasets, OpenAPI and Postman integration resources.",
  canonical: "/api/reference/",
});

export default async function ApiReferencePage() {
  return (
    <FeaturePageShell
      breadcrumbName="API Reference"
      path="/api/reference/"
      title="Pharos API Reference"
      leadParagraphs={["Integration guidance, endpoint contracts and public data artifacts. For supporter and partner keys, use Access."]}
    >
      <ApiTabs active="reference">{await ApiReferencePanel()}</ApiTabs>
    </FeaturePageShell>
  );
}
