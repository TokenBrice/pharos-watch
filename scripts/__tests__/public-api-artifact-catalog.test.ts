import { describe, expect, it } from "vitest";
import { ENDPOINT_DEFINITIONS } from "../../shared/lib/api-endpoints/definitions";
import {
  POSTMAN_FOLDERS,
  PUBLIC_API_ARTIFACT_ENDPOINTS,
  PUBLIC_API_ARTIFACT_TAGS,
  PUBLIC_STATIC_POSTMAN_REQUESTS,
} from "../lib/public-api-artifact-catalog";

const integrationFacingPublicKeys = ENDPOINT_DEFINITIONS
  .filter((endpoint) => (
    !endpoint.adminRequired
    && endpoint.methods.includes("GET")
    && endpoint.publicApiAccess !== "exempt"
  ))
  .map((endpoint) => endpoint.key)
  .sort();

const noKeyPublicArtifactKeys = ["health"];

describe("public API artifact catalog", () => {
  it("covers every integration-facing public GET endpoint definition", () => {
    expect(PUBLIC_API_ARTIFACT_ENDPOINTS.map((endpoint) => endpoint.key).sort()).toEqual(
      [...integrationFacingPublicKeys, ...noKeyPublicArtifactKeys].sort(),
    );
  });

  it("keeps artifact endpoint paths tied to runtime endpoint definitions", () => {
    const definitionsByKey = new Map(ENDPOINT_DEFINITIONS.map((endpoint) => [endpoint.key, endpoint]));

    for (const endpoint of PUBLIC_API_ARTIFACT_ENDPOINTS) {
      const definition = definitionsByKey.get(endpoint.key);
      expect(definition, endpoint.key).toBeDefined();
      expect(endpoint.path, endpoint.key).toMatch(/^\/api\//);

      if (!endpoint.path.includes("{")) {
        expect(endpoint.path, endpoint.key).toBe(definition?.path);
      }
    }
  });

  it("keeps all endpoint tags declared in the OpenAPI tag list", () => {
    const openApiTags = new Set(PUBLIC_API_ARTIFACT_TAGS);

    for (const endpoint of PUBLIC_API_ARTIFACT_ENDPOINTS) {
      for (const tag of endpoint.tags) {
        expect(openApiTags.has(tag), `${endpoint.key}:${tag}`).toBe(true);
      }
    }
  });

  it("keeps Postman requests assigned to declared folders", () => {
    const folderNames = new Set(POSTMAN_FOLDERS.map((folder) => folder.name));

    for (const endpoint of PUBLIC_API_ARTIFACT_ENDPOINTS) {
      expect(endpoint.postman, endpoint.key).toBeDefined();
      expect(folderNames.has(endpoint.postman?.folder), endpoint.key).toBe(true);
    }

    expect(PUBLIC_STATIC_POSTMAN_REQUESTS.map((request) => request.base)).toEqual(["site", "site", "site"]);
    expect(PUBLIC_STATIC_POSTMAN_REQUESTS.map((request) => request.noAuth)).toEqual([true, true, true]);
  });
});
