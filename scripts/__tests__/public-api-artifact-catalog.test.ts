import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENDPOINT_DEFINITIONS } from "@shared/lib/api-endpoints/definitions";
import {
  POSTMAN_FOLDERS,
  PUBLIC_API_ARTIFACT_ENDPOINTS,
  PUBLIC_API_ARTIFACT_TAGS,
  PUBLIC_STATIC_POSTMAN_REQUESTS,
  type PostmanRequestConfig,
  type PublicApiArtifactEndpoint,
} from "../lib/public-api-artifact-catalog";

const integrationFacingPublicKeys = ENDPOINT_DEFINITIONS.filter(
  (endpoint) => !endpoint.adminRequired && endpoint.methods.includes("GET") && endpoint.publicApiAccess !== "exempt",
)
  .map((endpoint) => endpoint.key)
  .sort();

const noKeyPublicArtifactKeys = ["health"];
const FORBIDDEN_ARTIFACT_PATHS = [
  "/api/api-key-requests",
  "/api/api-key-requests/verify",
  "/api/api-key-requests-admin",
];

function isPostmanRequestConfig(
  postman: PostmanRequestConfig | readonly PostmanRequestConfig[],
): postman is PostmanRequestConfig {
  return !Array.isArray(postman);
}

function postmanRequests(postman: PublicApiArtifactEndpoint["postman"]): readonly PostmanRequestConfig[] {
  if (!postman) return [];
  return isPostmanRequestConfig(postman) ? [postman] : postman;
}

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
      } else {
        // Catalog uses OpenAPI {placeholder} segments; the runtime definition
        // ships a canary value (e.g. "usdt-tether", "2026-05-16"). Compare
        // structural segments by collapsing both sides to the catalog's
        // template-segment shape: any catalog segment containing `{` matches
        // ANY single segment in the definition.
        const catalogSegments = endpoint.path.split("/");
        const definitionSegments = (definition?.path ?? "").split("/");
        expect(definitionSegments.length, endpoint.key).toBe(catalogSegments.length);
        for (let i = 0; i < catalogSegments.length; i++) {
          const catalogSeg = catalogSegments[i];
          if (catalogSeg.includes("{")) continue; // placeholder — any value OK
          expect(definitionSegments[i], `${endpoint.key} segment ${i}`).toBe(catalogSeg);
        }
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
      for (const request of postmanRequests(endpoint.postman)) {
        expect(folderNames.has(request.folder), endpoint.key).toBe(true);
      }
    }

    expect(PUBLIC_STATIC_POSTMAN_REQUESTS.map((request) => request.base)).toEqual(["site", "site", "site"]);
    expect(PUBLIC_STATIC_POSTMAN_REQUESTS.map((request) => request.noAuth)).toEqual([true, true, true]);
  });

  it("excludes self-serve issuance and admin routes from public artifacts", () => {
    const catalogPaths = PUBLIC_API_ARTIFACT_ENDPOINTS.map((endpoint) => endpoint.path);
    const openApi = JSON.parse(readFileSync(join(process.cwd(), "public/openapi.json"), "utf8")) as {
      paths?: Record<string, unknown>;
    };
    const postman = JSON.parse(
      readFileSync(join(process.cwd(), "public/postman/pharos-api.postman_collection.json"), "utf8"),
    ) as unknown;
    const postmanText = JSON.stringify(postman);

    for (const path of FORBIDDEN_ARTIFACT_PATHS) {
      expect(catalogPaths, path).not.toContain(path);
      expect(Object.keys(openApi.paths ?? {}), path).not.toContain(path);
      expect(postmanText, path).not.toContain(path);
    }
  });

  it("keeps the public artifact catalog GET-only by omitting method declarations", () => {
    for (const endpoint of PUBLIC_API_ARTIFACT_ENDPOINTS) {
      expect("method" in endpoint, endpoint.key).toBe(false);
      expect("methods" in endpoint, endpoint.key).toBe(false);
    }
  });

  it("keeps generated OpenAPI and Postman artifacts free of POST operations", () => {
    const openApi = JSON.parse(readFileSync(join(process.cwd(), "public/openapi.json"), "utf8")) as {
      paths?: Record<string, Record<string, unknown>>;
    };
    const postman = JSON.parse(
      readFileSync(join(process.cwd(), "public/postman/pharos-api.postman_collection.json"), "utf8"),
    ) as {
      item?: Array<{ item?: Array<{ request?: { method?: string } }> }>;
    };

    for (const operations of Object.values(openApi.paths ?? {})) {
      expect(Object.keys(operations)).toEqual(["get"]);
    }

    const postmanMethods =
      postman.item?.flatMap((folder) => folder.item?.map((item) => item.request?.method) ?? []) ?? [];
    expect(new Set(postmanMethods)).toEqual(new Set(["GET"]));
  });

  it("documents the blacklist API's symbol filter and supported query contract", () => {
    const endpoint = PUBLIC_API_ARTIFACT_ENDPOINTS.find((entry) => entry.key === "blacklist");
    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.map((parameter) => parameter.name)).toEqual([
      "stablecoin",
      "chain",
      "chainId",
      "eventType",
      "q",
      "sortBy",
      "sortDirection",
      "limit",
      "offset",
      "includeTotal",
    ]);

    const stablecoin = endpoint?.parameters?.find((parameter) => parameter.name === "stablecoin");
    expect(stablecoin?.description).toContain("stablecoin symbol");
    expect(stablecoin?.schema.enum).toContain("USDT");
    expect(stablecoin?.schema.enum).not.toContain("usdt-tether");

    const eventType = endpoint?.parameters?.find((parameter) => parameter.name === "eventType");
    expect(eventType?.schema.enum).toEqual(["blacklist", "unblacklist", "destroy"]);
    const sortBy = endpoint?.parameters?.find((parameter) => parameter.name === "sortBy");
    expect(sortBy?.schema.enum).toEqual(["date", "stablecoin", "chain", "event"]);
    const sortDirection = endpoint?.parameters?.find((parameter) => parameter.name === "sortDirection");
    expect(sortDirection?.schema.enum).toEqual(["asc", "desc"]);
    const limit = endpoint?.parameters?.find((parameter) => parameter.name === "limit");
    expect(limit?.schema.minimum).toBe(0);
    expect(limit?.schema.maximum).toBe(1000);
    expect(postmanRequests(endpoint?.postman)[0]?.query?.stablecoin).toBe("{{blacklistStablecoinSymbol}}");
    expect(postmanRequests(endpoint?.postman)[0]?.query?.chainId).toBe("ethereum");
    expect(postmanRequests(endpoint?.postman)[0]?.query?.includeTotal).toBe("true");
  });

  it("documents the yield-history query contract used by OpenAPI and Postman", () => {
    const endpoint = PUBLIC_API_ARTIFACT_ENDPOINTS.find((entry) => entry.key === "yield-history");
    expect(endpoint).toBeDefined();
    expect(endpoint?.parameters?.map((parameter) => parameter.name)).toEqual([
      "stablecoin",
      "days",
      "mode",
      "sourceKey",
    ]);

    const stablecoin = endpoint?.parameters?.find((parameter) => parameter.name === "stablecoin");
    expect(stablecoin?.required).toBe(true);

    const days = endpoint?.parameters?.find((parameter) => parameter.name === "days");
    expect(days?.schema.minimum).toBe(1);
    expect(days?.schema.maximum).toBe(365);

    const mode = endpoint?.parameters?.find((parameter) => parameter.name === "mode");
    expect(mode?.schema.enum).toEqual(["best", "source"]);
    const requests = postmanRequests(endpoint?.postman);
    expect(requests.map((request) => request.query?.mode)).toEqual(["best", "source"]);
    expect(requests[0]?.description).toContain("1-365");
    expect(requests[1]?.query?.sourceKey).toBe("{{yieldSourceKey}}");
  });
});
