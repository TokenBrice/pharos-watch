import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { collectOpenApiRoutes, END_MARKER, loadOpenapi, renderGeneratedBlock, replaceGeneratedBlock, START_MARKER } from "../maintenance/generate-api-reference.ts";
import { PUBLIC_API_ARTIFACT_ENDPOINTS } from "../lib/public-api-artifact-catalog";

describe("API reference generated markers", () => {
  it("replaces current markers without changing authored prose", () => {
    expect(replaceGeneratedBlock(`before\n${START_MARKER}\nstale\n${END_MARKER}\nafter`, "fresh"))
      .toBe("before\nfresh\nafter");
  });

  it.each([
    "no generated markers",
    `${START_MARKER}\nmissing end`,
    `missing start\n${END_MARKER}`,
    `${END_MARKER}\nreversed\n${START_MARKER}`,
    "<!-- GENERATED-START: public-endpoints-quick-reference -->\nlegacy\n<!-- GENERATED-END: public-endpoints-quick-reference -->",
  ])("rejects missing, reversed, or retired markers: %s", (doc) => {
    expect(() => replaceGeneratedBlock(doc, "fresh")).toThrow("Could not find a valid generated block");
  });
});

describe("API reference endpoint narratives", () => {
  it("points catalog integration guidance at the canonical Reference document", () => {
    const linked = PUBLIC_API_ARTIFACT_ENDPOINTS.filter((endpoint) => endpoint.description.includes("https://pharos.watch/api/"));
    expect(linked.length).toBeGreaterThan(0);
    for (const endpoint of linked) {
      expect(endpoint.description).toContain("https://pharos.watch/api/reference/#");
      expect(endpoint.description).not.toContain("https://pharos.watch/api/#");
    }
  });

  it("uses catalog descriptions through OpenAPI without a second operation inventory", () => {
    const spec = loadOpenapi();
    const routes = collectOpenApiRoutes(spec);
    const rendered = renderGeneratedBlock(spec);
    for (const endpoint of PUBLIC_API_ARTIFACT_ENDPOINTS) {
      const route = routes.find((candidate) => candidate.path === endpoint.path);
      expect(route?.description).toBe(endpoint.description);
      expect(rendered).toContain(endpoint.description.split(/(?<=[.!?])\s/, 1)[0]);
      expect(endpoint.description).not.toMatch(/\]\((?:\.\/|#)/);
    }
  });

  it("keeps the Markdown preview compact while linking to the full OpenAPI narrative", () => {
    const spec = loadOpenapi();
    const path = spec.paths["/api/stablecoins"] as { get: { description: string } };
    path.get.description = "One endpoint preview. Detailed contract retained only in the exported description.";
    const rendered = renderGeneratedBlock(spec);
    expect(rendered).toContain("One endpoint preview. [Full endpoint contract](https://pharos.watch/openapi.json#/paths/~1api~1stablecoins/get)");
    expect(rendered).not.toContain("Detailed contract retained only in the exported description.");
    expect(collectOpenApiRoutes(spec).find((route) => route.path === "/api/stablecoins")?.description)
      .toBe(path.get.description);
  });

  it("accepts an operation's narrative and identity directly from OpenAPI", () => {
    const spec = { paths: { "/api/stablecoins": { get: {
      operationId: "catalogIdentity", description: "One authored endpoint narrative.",
    } } } };
    expect(collectOpenApiRoutes(spec)[0]).toMatchObject({
      operationId: "catalogIdentity", description: "One authored endpoint narrative.",
    });
    expect(() => collectOpenApiRoutes({ paths: { "/api/stablecoins": { get: {
      operationId: "catalogIdentity",
    } } } })).toThrow("Missing description for GET /api/stablecoins");
  });
});

describe("generate-api-reference check mode", () => {
  it.each([
    { modified: true, exitCode: 1, message: "docs/api-reference.md is out of date" },
    { modified: false, exitCode: 0, message: "docs/api-reference.md is current" },
  ])("checks a generated API block without writing the document (modified: $modified)", ({ modified, exitCode, message }) => {
    // Keep both the filesystem mocks and exit status out of Vitest's shared
    // process. Use a path-specific read, not a next-call mock that a loader can consume.
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
      import fs from "node:fs";
      import { resolve } from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      import * as generator from ${JSON.stringify(pathToFileURL(resolve("scripts/maintenance/generate-api-reference.ts")).href)};
      const docPath = resolve("docs/api-reference.md");
      const readFileSync = fs.readFileSync;
      const originalDocument = readFileSync(docPath, "utf8");
      const block = ${modified}
        ? generator.START_MARKER + "\\nmodified generated content\\n" + generator.END_MARKER
        : generator.renderGeneratedBlock(generator.loadOpenapi());
      const fixture = "hand-authored prefix\\n" + block + "\\nhand-authored suffix";
      let writes = 0;
      fs.readFileSync = (path, ...args) => path === docPath ? fixture : readFileSync(path, ...args);
      fs.writeFileSync = () => { writes++; };
      syncBuiltinESMExports();
      generator.main(true);
      console.log(JSON.stringify({ writes, unchanged: readFileSync(docPath, "utf8") === originalDocument }));
    `], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(`${result.stdout}${result.stderr}`).toContain(message);
    expect(result.stdout.trim().split("\n").pop()).toBe('{"writes":0,"unchanged":true}');
  });
});
