import { describe, expect, it } from "vitest";
import { PHAROS_ORG_NODE, safeJsonLd } from "@/lib/json-ld";

describe("safeJsonLd", () => {
  const nested = { item: { text: '</script><script>alert("x")</script>\\path café \u2028\u2029' } };

  it.each([{ data: nested }, { data: [nested] }])("escapes HTML script delimiters without corrupting nested data: %j", ({ data }) => {
    const serialized = safeJsonLd(data);
    expect(serialized).not.toMatch(/<\/script/i);
    expect(JSON.parse(serialized)).toEqual(data);
  });
});

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
    // sameAs asserts identity equivalence: these must all BE Pharos, not merely
    // relate to it. Related properties (bot, community chat, PharosVille) moved
    // to WebSite.relatedLink; the founder's personal profiles live on the Person
    // node. A separate "Pharos Network" blockchain exists, so entity precision
    // here is load-bearing for disambiguation.
    expect(parsed.sameAs).toEqual([
      "https://x.com/PharosWatch",
      "https://github.com/TokenBrice/pharos-watch",
      "https://t.me/pharoswatch",
    ]);
    expect(parsed.alternateName).toEqual(expect.arrayContaining(["Pharos Watch"]));
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
