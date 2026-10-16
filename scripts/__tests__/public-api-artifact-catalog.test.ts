import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PUBLIC_API_ARTIFACT_ENDPOINTS,
} from "../lib/public-api-artifact-catalog";

const FORBIDDEN_ARTIFACT_PATHS = [
  "/api/donor-key-claims",
  "/api/feedback",
  "/api/api-keys",
  "/api/stablecoin-detail-snapshot-inputs",
];

describe("public API artifact catalog", () => {
  it("excludes key-issuance, write-only and admin routes from public artifacts", () => {
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

});
