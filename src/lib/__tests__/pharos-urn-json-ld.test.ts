import { describe, expect, it } from "vitest";
import { buildPharosUrnJsonLdIdentifier } from "@/lib/pharos-urn-json-ld";

describe("buildPharosUrnJsonLdIdentifier", () => {
  it("builds the schema.org PropertyValue wrapper for a Pharos URN", () => {
    expect(buildPharosUrnJsonLdIdentifier("methodology", "dews", "v6.0")).toEqual({
      "@type": "PropertyValue",
      propertyID: "Pharos URN",
      value: "urn:pharos:methodology:dews@v6.0",
    });
  });
});
