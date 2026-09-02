import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JsonLdScript } from "@/components/json-ld-script";
import { safeJsonLd } from "@/lib/json-ld";

describe("JsonLdScript", () => {
  it("preserves the existing safe serialization for HTML delimiters and line separators", () => {
    const json = safeJsonLd({ value: "<>&\u2028\u2029" });

    expect(json).toBe('{"value":"\\u003c\\u003e&\u2028\u2029"}');
    expect(renderToStaticMarkup(<JsonLdScript json={json} />)).toBe(
      `<script type="application/ld+json">${json}</script>`,
    );
  });
});
