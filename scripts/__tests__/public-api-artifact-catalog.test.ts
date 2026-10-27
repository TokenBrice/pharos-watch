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

  it("resolves every Postman variable from the collection plus environment, including snapshotDate", () => {
    const read = (file: string) => JSON.parse(
      readFileSync(join(process.cwd(), "public/postman", file), "utf8"),
    ) as Record<string, unknown>;
    const collection = read("pharos-api.postman_collection.json") as {
      variable: { key: string; value: string }[];
    };
    const environment = read("pharos-api.postman_environment.json") as {
      values: { key: string; value: string; enabled: boolean }[];
    };

    const fromCollection = collection.variable.find((entry) => entry.key === "snapshotDate");
    const fromEnvironment = environment.values.find((entry) => entry.key === "snapshotDate");
    expect(fromCollection?.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(fromEnvironment?.value).toBe(fromCollection?.value);
    expect(environment.values.every((entry) => entry.enabled)).toBe(true);

    const declared = new Set([
      ...collection.variable.map((entry) => entry.key),
      ...environment.values.map((entry) => entry.key),
    ]);
    expect(declared.has("apiKey")).toBe(true);
    const referenced = new Set(
      [...JSON.stringify(collection.variable.length ? { ...collection, variable: undefined } : collection)
        .matchAll(/\{\{([A-Za-z0-9_]+)\}\}/g)].map((match) => match[1]),
    );
    expect(referenced.has("snapshotDate")).toBe(true);
    for (const name of referenced) expect(declared.has(name), name).toBe(true);

    const text = JSON.stringify(collection);
    expect(text).toContain("/api/snapshots/{{snapshotDate}}.json");
    expect(text).toContain("/api/snapshot/{{snapshotDate}}/stablecoin/{{stablecoinId}}");
    expect(text).toContain("/api/snapshots/index (API key required)");
  });

});
