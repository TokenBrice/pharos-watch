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
  it("links the organization to its public identities, including Wikidata", () => {
    expect(PHAROS_ORG_NODE.sameAs).toEqual([
      "https://x.com/PharosWatch",
      "https://github.com/TokenBrice/pharos-watch",
      "https://t.me/pharoswatch",
      "https://www.wikidata.org/wiki/Q141899217",
    ]);
  });
});
