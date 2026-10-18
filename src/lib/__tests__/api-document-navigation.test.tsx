import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiTabs } from "@/app/api/api-tabs";
import { getApiDocumentRedirect } from "@/lib/api-document-navigation";
import { API_PAGE_ANCHORS } from "@shared/lib/public-api-contract";

const noTarget = () => false;

describe("API static documents", () => {
  it.each(["#reference", "#polling-guidance", "#get-api-stablecoins", "#dataset-top-stablecoins", "#encoded%2Dfragment"])(
    "preserves legacy Reference fragments: %s", (hash) => {
      expect(getApiDocumentRedirect("access", hash, noTarget)).toBe(`/api/reference/${hash}`);
    },
  );

  it.each(["access", ...Object.values(API_PAGE_ANCHORS)])("preserves Access fragment ownership: %s", (id) => {
    expect(getApiDocumentRedirect("reference", `#${id}`, noTarget)).toBe(`/api/#${id}`);
    expect(getApiDocumentRedirect("access", `#${id}`, () => true)).toBeNull();
  });

  it("does not redirect an existing target, empty fragment, malformed encoding, or unknown Reference fragment", () => {
    expect(getApiDocumentRedirect("reference", "#get-api-stablecoins", () => true)).toBeNull();
    expect(getApiDocumentRedirect("access", "", noTarget)).toBeNull();
    expect(getApiDocumentRedirect("access", "#%E0%A4", noTarget)).toBeNull();
    expect(getApiDocumentRedirect("reference", "#unknown", noTarget)).toBeNull();
  });

  it.each(["access", "reference"] as const)("exports only the supplied %s document with crawlable navigation", (active) => {
    const html = renderToStaticMarkup(<ApiTabs active={active}><p>Document body</p></ApiTabs>);
    expect(html).toContain(`id="${active}"`);
    expect(html).toContain('href="/api/#access"');
    expect(html).toContain('href="/api/reference/#reference"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("tabpanel");
    expect(html).not.toContain("hidden=");
  });
});
