import { describe, expect, it } from "vitest";
import { PHAROS_ORG_NODE, safeJsonLd } from "@/lib/json-ld";

describe("PHAROS_ORG_NODE", () => {
  it("carries policy, funding, contact, and ecosystem links as valid JSON-LD", () => {
    const parsed = JSON.parse(safeJsonLd(PHAROS_ORG_NODE));

    expect(parsed).toMatchObject({
      "@type": "Organization",
      "@id": "https://pharos.watch#organization",
      foundingDate: "2026-01-29",
      ethicsPolicy: "https://pharos.watch/about/#principles",
      correctionsPolicy: "https://pharos.watch/about/#corrections-policy",
      funding: {
        "@type": "Grant",
        "@id": "https://pharos.watch/funding/#community-support",
        url: "https://pharos.watch/funding/",
      },
      founder: { "@id": "https://pharos.watch#person-tokenbrice" },
    });
    expect(parsed.sameAs).toEqual(
      expect.arrayContaining([
        "https://x.com/PharosWatch",
        "https://github.com/TokenBrice/pharos-watch",
        "https://pharosville.pharos.watch/",
      ]),
    );
    expect(parsed.contactPoint).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "@type": "ContactPoint",
          contactType: "corrections and data issues",
          url: "https://github.com/TokenBrice/pharos-watch/issues",
        }),
      ]),
    );
  });
});
