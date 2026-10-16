import { describe, expect, it } from "vitest";
import { safeJsonLd } from "@/lib/json-ld";

describe("safeJsonLd", () => {
  const nested = { item: { text: '</script><script>alert("x")</script>\\path café \u2028\u2029' } };

  it.each([{ data: nested }, { data: [nested] }])("escapes HTML script delimiters without corrupting nested data: %j", ({ data }) => {
    const serialized = safeJsonLd(data);
    expect(serialized).not.toMatch(/<\/script/i);
    expect(JSON.parse(serialized)).toEqual(data);
  });
});

