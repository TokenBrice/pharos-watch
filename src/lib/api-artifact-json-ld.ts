import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PUBLIC_API_HOST } from "@shared/lib/public-api-contract";
import {
  buildCoverageDatasetJsonLd,
  buildPublicDatasetMirrorJsonLd,
  PUBLIC_DATASET_JSON_LD_DESCRIPTORS,
} from "@/lib/analytics-dataset-json-ld";
import { buildCemeteryDatasetJsonLd } from "@/lib/cemetery-json-ld";

export function buildApiArtifactCatalogJsonLd(options: { siteUrl?: string } = {}) {
  const siteUrl = options.siteUrl ?? SITE_URL;
  const catalogId = `${siteUrl}/about/api/#data-catalog`;
  const organization = { "@id": `${siteUrl}#organization` };
  const coverageDataset = buildCoverageDatasetJsonLd({ siteUrl });
  const cemeteryDataset = buildCemeteryDatasetJsonLd();
  const publicDatasets = PUBLIC_DATASET_JSON_LD_DESCRIPTORS.map((descriptor) =>
    buildPublicDatasetMirrorJsonLd(descriptor.slug, { siteUrl, catalogId }),
  );

  return [
    {
      "@context": "https://schema.org",
      "@type": "DataCatalog",
      "@id": catalogId,
      name: "Pharos Public API Data Catalog",
      description:
        "Machine-readable Pharos integration artifacts and public stablecoin data surfaces for external API consumers.",
      url: `${siteUrl}/about/api/`,
      inLanguage: "en",
      provider: organization,
      publisher: organization,
      isAccessibleForFree: true,
      dataset: [
        { "@id": `${siteUrl}/about/api/#openapi-spec` },
        { "@id": `${siteUrl}/about/api/#postman-collection` },
        { "@id": `${siteUrl}/about/api/#postman-environment` },
        { "@id": `${siteUrl}/coverage/#dataset` },
        { "@id": `${siteUrl}/cemetery/#dataset` },
        ...PUBLIC_DATASET_JSON_LD_DESCRIPTORS.map((descriptor) => ({
          "@id": `${siteUrl}/datasets/${descriptor.slug}/#dataset`,
        })),
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "WebAPI",
      "@id": `${siteUrl}/about/api/#webapi`,
      name: "Pharos API",
      description:
        "Read-only public integration API for stablecoin market, peg, liquidity, risk, blacklist, yield, chain, and flow data.",
      url: `${siteUrl}/about/api/`,
      documentation: `${siteUrl}/about/api/`,
      endpointUrl: PUBLIC_API_HOST,
      provider: organization,
      isPartOf: { "@id": catalogId },
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${siteUrl}/about/api/#openapi-spec`,
      additionalType: "https://schema.org/APIReference",
      name: "Pharos OpenAPI Specification",
      description: "OpenAPI 3.1 specification for the public Pharos API endpoint catalog.",
      url: `${siteUrl}/openapi.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${siteUrl}/about/api/#postman-collection`,
      name: "Pharos Postman Collection",
      description: "Postman collection for testing and importing public Pharos API requests.",
      url: `${siteUrl}/postman/pharos-api.postman_collection.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${siteUrl}/about/api/#postman-environment`,
      name: "Pharos Postman Environment",
      description: "Postman environment template for the production Pharos API host.",
      url: `${siteUrl}/postman/pharos-api.postman_environment.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    { ...cemeteryDataset, includedInDataCatalog: { "@id": catalogId } },
    coverageDataset,
    ...publicDatasets,
  ];
}
