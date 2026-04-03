import { describe, expect, it } from "vitest";
import { loadApiReferenceDocument } from "@/lib/api-reference-doc";

describe("loadApiReferenceDocument", () => {
  it("loads the checked-in API reference into navigable sections", async () => {
    const document = await loadApiReferenceDocument();

    expect(document.introBlocks.length).toBeGreaterThan(0);
    expect(document.sections.length).toBeGreaterThan(5);
    expect(document.sections[0]?.title).toBe("Surface Split");
    expect(document.sections.some((section) => section.title === "Public Endpoints")).toBe(true);
    expect(document.sections.some((section) => section.title === "Admin Endpoints")).toBe(true);
  });

  it("captures endpoint subsections under the public endpoint group", async () => {
    const document = await loadApiReferenceDocument();
    const publicEndpoints = document.sections.find((section) => section.title === "Public Endpoints");

    expect(publicEndpoints).toBeDefined();
    expect(publicEndpoints?.subsections.length).toBeGreaterThan(10);
    expect(publicEndpoints?.subsections[0]?.title).toBe("`GET /api/stablecoins`");
  });
});
