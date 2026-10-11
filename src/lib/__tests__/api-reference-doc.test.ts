import { describe, expect, it } from "vitest";
import {
  getPublicApiEndpointSummaries,
  loadApiReferenceDocument,
} from "@/lib/api-reference-doc";

describe("loadApiReferenceDocument", () => {
  it("loads the checked-in API reference into navigable sections", async () => {
    const document = await loadApiReferenceDocument();

    expect(document.introBlocks.length).toBeGreaterThan(0);
    expect(document.sections.length).toBeGreaterThan(5);
    expect(document.sections[0]?.title).toBe("Surface Split");
    expect(document.sections.some((section) => section.title === "Public Endpoints")).toBe(true);
    // Admin sections intentionally moved to the unpublished operator-only companion reference.
    expect(document.sections.some((section) => section.title === "Admin Endpoints")).toBe(false);
  });

  it("captures endpoint subsections under the public endpoint group", async () => {
    const document = await loadApiReferenceDocument();
    const publicEndpoints = document.sections.find((section) => section.title === "Public Endpoints");
    const endpointSubsections = publicEndpoints?.subsections.filter((section) => section.method !== null) ?? [];

    expect(publicEndpoints).toBeDefined();
    expect(endpointSubsections.length).toBeGreaterThan(10);
    expect(endpointSubsections[0]?.title).toBe("`GET /api/events`");
  });

  it("extracts a public endpoint directory from the canonical reference", async () => {
    const document = await loadApiReferenceDocument();
    const endpoints = getPublicApiEndpointSummaries(document);

    expect(endpoints.length).toBeGreaterThan(10);
    expect(endpoints[0]).toEqual({
      id: "get-api-events",
      method: "GET",
      path: "/api/events",
      title: "GET /api/events",
    });
    expect(endpoints.some((endpoint) => endpoint.path === "/api/status")).toBe(false);
  });

  it("keeps escaped pipe unions inside one table cell", async () => {
    const document = await loadApiReferenceDocument();
    const stablecoins = document.sections
      .find((section) => section.title === "Public Endpoints")
      ?.subsections.find((section) => section.title === "`GET /api/stablecoins`");
    const stablecoinDataTable = stablecoins?.blocks.find(
      (block) => block.type === "table" && block.rows.some((row) => row[0] === "`geckoId`"),
    );

    expect(stablecoinDataTable?.type).toBe("table");
    if (stablecoinDataTable?.type !== "table") return;

    const geckoIdRow = stablecoinDataTable.rows.find((row) => row[0] === "`geckoId`");
    // The escaped union must stay one cell; the description column is editorial.
    expect(geckoIdRow).toEqual(["`geckoId`", "`string | null`", expect.any(String)]);
  });
});
