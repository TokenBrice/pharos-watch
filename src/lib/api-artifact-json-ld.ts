import { SITE_ORIGIN as SITE_URL } from "@shared/lib/runtime-origins";
import { PUBLIC_API_HOST } from "@shared/lib/public-api-contract";
import {
  buildCoverageDatasetJsonLd,
  buildPharosDataCatalogReference,
  buildPublicDatasetMirrorJsonLd,
  PHAROS_PUBLIC_DATA_CATALOG_ID,
  PHAROS_PUBLIC_DATA_CATALOG_NAME,
  PUBLIC_DATASET_JSON_LD_DESCRIPTORS,
} from "@/lib/analytics-dataset-json-ld";
import { buildCemeteryDatasetJsonLd } from "@/lib/cemetery-json-ld";

export function buildApiArtifactCatalogJsonLd() {
  const catalogId = PHAROS_PUBLIC_DATA_CATALOG_ID;
  const catalogReference = buildPharosDataCatalogReference();
  const organization = { "@id": `${SITE_URL}#organization` };
  const coverageDataset = buildCoverageDatasetJsonLd();
  const cemeteryDataset = buildCemeteryDatasetJsonLd();
  const publicDatasets = PUBLIC_DATASET_JSON_LD_DESCRIPTORS.map((descriptor) =>
    buildPublicDatasetMirrorJsonLd(descriptor.slug),
  );

  return [
    {
      "@context": "https://schema.org",
      "@type": "DataCatalog",
      "@id": catalogId,
      name: PHAROS_PUBLIC_DATA_CATALOG_NAME,
      description:
        "Machine-readable Pharos integration artifacts and public stablecoin data surfaces for external API consumers.",
      url: `${SITE_URL}/about/api/`,
      inLanguage: "en",
      provider: organization,
      publisher: organization,
      isAccessibleForFree: true,
      dataset: [
        { "@id": `${SITE_URL}/about/api/#openapi-spec` },
        { "@id": `${SITE_URL}/about/api/#postman-collection` },
        { "@id": `${SITE_URL}/about/api/#postman-environment` },
        { "@id": `${SITE_URL}/coverage/#dataset` },
        { "@id": `${SITE_URL}/cemetery/#dataset` },
        ...PUBLIC_DATASET_JSON_LD_DESCRIPTORS.map((descriptor) => ({
          "@id": `${SITE_URL}/datasets/${descriptor.slug}/#dataset`,
        })),
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "WebAPI",
      "@id": `${SITE_URL}/about/api/#webapi`,
      name: "Pharos API",
      description:
        "Read-only public integration API for stablecoin market, peg, liquidity, risk, blacklist, yield, chain, and flow data.",
      url: `${SITE_URL}/about/api/`,
      documentation: `${SITE_URL}/about/api/`,
      endpointUrl: PUBLIC_API_HOST,
      provider: organization,
      isPartOf: { "@id": catalogId },
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${SITE_URL}/about/api/#openapi-spec`,
      additionalType: "https://schema.org/APIReference",
      name: "Pharos OpenAPI Specification",
      description: "OpenAPI 3.1 specification for the public Pharos API endpoint catalog.",
      url: `${SITE_URL}/openapi.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${SITE_URL}/about/api/#postman-collection`,
      name: "Pharos Postman Collection",
      description: "Postman collection for testing and importing public Pharos API requests.",
      url: `${SITE_URL}/postman/pharos-api.postman_collection.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    {
      "@context": "https://schema.org",
      "@type": "CreativeWork",
      "@id": `${SITE_URL}/about/api/#postman-environment`,
      name: "Pharos Postman Environment",
      description: "Postman environment template for the production Pharos API host.",
      url: `${SITE_URL}/postman/pharos-api.postman_environment.json`,
      encodingFormat: "application/json",
      isAccessibleForFree: true,
      isPartOf: { "@id": catalogId },
      publisher: organization,
    },
    { ...cemeteryDataset, includedInDataCatalog: catalogReference },
    coverageDataset,
    ...publicDatasets,
  ];
}
